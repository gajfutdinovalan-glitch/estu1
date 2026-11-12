from __future__ import annotations

import gc
import http.client
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portable_core as core
import portable_server as server
from portable_modules import add_request, get_state, update_request
from portable_shifts import DEFAULT_SETTINGS, get_schedule, save_schedule, shift_for_instant
from portable_users import create_user, list_users, update_user


class ShiftRoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="estu-shifts-test-")
        self.previous = (core.DATA_DIR, core.DB_PATH, core.SEED_PATH, server.LOG_PATH)
        core.DATA_DIR = Path(self.temp.name)
        core.DB_PATH = core.DATA_DIR / "test.sqlite"
        core.SEED_PATH = core.DATA_DIR / "no-seed.json"
        server.LOG_PATH = core.DATA_DIR / "server.log"
        core.initialize_database()
        with core.transaction() as connection:
            connection.execute("INSERT INTO departments(name,sort_order) VALUES('РЭЛ',1)")
            connection.execute("INSERT INTO fleet(board,model) VALUES('TEST-1','Test vehicle')")
        self.admin = self.raw(create_user({"displayName": "Test admin", "password": "test-admin-only"}, None, "admin"))

    def tearDown(self):
        core.DATA_DIR, core.DB_PATH, core.SEED_PATH, server.LOG_PATH = self.previous
        gc.collect()
        self.temp.cleanup()

    def raw(self, public):
        with core.connect() as connection:
            return dict(connection.execute("SELECT * FROM users WHERE id=?", (public["id"],)).fetchone())

    def profile(self, scope, shift=None):
        return self.raw(create_user({"displayName": scope + (shift or ""), "accessScope": scope,
                                    "password": "test-profile-only", "shiftId": shift, "department": "РЭЛ" if scope == "rel" else None}, self.admin))

    def test_calendar_boundaries_and_timezone(self):
        cases = {"2026-10-01T08:00": "day_1", "2026-10-02T20:00": "night_1",
                 "2026-10-03T07:59": "night_1", "2026-10-03T08:00": "day_2",
                 "2026-10-03T19:59": "day_2", "2026-10-03T20:00": "night_2",
                 "2026-10-04T07:59": "night_2", "2026-10-05T08:00": "day_1",
                 "2026-09-30T20:00": "night_2"}
        for value, expected in cases.items():
            with self.subTest(value=value):
                result = shift_for_instant(DEFAULT_SETTINGS, datetime.fromisoformat(value))
                self.assertEqual(result["id"], expected)
                self.assertEqual((datetime.fromisoformat(result["endsAt"]) - datetime.fromisoformat(result["startsAt"])).total_seconds(), 43200)
        night = shift_for_instant(DEFAULT_SETTINGS, datetime(2026, 10, 3, 7, 59))
        self.assertEqual(night["workDate"], "2026-10-02")
        self.assertEqual(shift_for_instant(DEFAULT_SETTINGS, datetime(2026, 10, 3, 5, tzinfo=timezone.utc))["id"], "day_2")

    def test_four_profiles_and_scope_isolation(self):
        for shift in ("day_1", "day_2", "night_1", "night_2"):
            user = self.profile("master", shift)
            public = core.public_user(user)
            self.assertEqual(public["shiftId"], shift)
            self.assertEqual(public["department"], core.TO_DEPARTMENT)
            self.assertFalse(public["permissions"]["viewAllRequests"])
            self.assertIn("shifts", public["modules"])
        with self.assertRaises(core.ApiError):
            self.profile("master")
        with self.assertRaises(core.ApiError):
            self.profile("rel", "day_1")
        with self.assertRaises(core.ApiError):
            self.profile("pto")
        manager = self.profile("management")
        self.assertTrue(core.permissions_for_user(manager)["manageShifts"])
        self.assertFalse(core.permissions_for_user(manager)["manageUsers"])
        with self.assertRaises(core.ApiError) as denied:
            list_users(manager)
        self.assertEqual(denied.exception.status, 403)

    def test_schedule_validation_and_permissions(self):
        worker = self.profile("master", "day_1")
        manager = self.profile("management")
        schedule = get_schedule(worker, "2026-10-01", "8")
        self.assertEqual([day["team"] for day in schedule["calendar"]], [1, 1, 2, 2, 1, 1, 2, 2])
        self.assertFalse(schedule["canManage"])
        with self.assertRaises(core.ApiError):
            save_schedule(DEFAULT_SETTINGS, worker)
        with self.assertRaises(core.ApiError):
            save_schedule({**DEFAULT_SETTINGS, "nightStart": "19:00"}, manager)
        with self.assertRaises(core.ApiError):
            get_schedule(worker, "2026-10-01", "63")
        changed = save_schedule({**DEFAULT_SETTINGS, "anchorDate": "2026-10-03"}, manager)
        self.assertTrue(changed["canManage"])
        with core.connect() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM audit_log WHERE entity_type='shift_schedule'").fetchone()[0], 1)

    def test_request_department_boundary(self):
        worker = self.profile("master", "day_1")
        rel = self.profile("rel")
        a = add_request({"board": "TEST-1", "description": "TO issue"}, worker)
        b = add_request({"board": "TEST-1", "description": "REL issue"}, rel)
        self.assertEqual(a["department"],core.TO_DEPARTMENT)
        self.assertEqual(b["department"],core.TO_DEPARTMENT)
        self.assertEqual(get_state(rel, True, False)["requests"], [])
        with self.assertRaises(core.ApiError):
            update_request(b["id"], {"status": "in_progress"}, worker)
        manager = self.profile("management")
        self.assertEqual(len(get_state(manager, True, False)["requests"]), 2)

    def test_role_change_resets_default_grants(self):
        other = self.raw(create_user({"displayName": "Other admin", "accessScope": "admin", "password": "other-admin-only"}, self.admin))
        changed = update_user(other["id"], {"accessScope": "management"}, self.admin)
        self.assertNotIn("users", changed["modules"])
        self.assertFalse(changed["permissions"]["manageUsers"])
        with self.assertRaises(core.ApiError):
            update_user(self.admin["id"], {"accessScope": "management"}, self.admin)
        with self.assertRaises(core.ApiError):
            create_user({"displayName": "Bad", "accessScope": "rel", "password": "test-only", "permissions": {"manageUsers": "false"}}, self.admin)

    def test_migration_preserves_password_and_records(self):
        worker = self.profile("master", "day_1")
        # The legacy fixture has no shift assignment, regardless of the current shift.
        request = add_request({"board": "TEST-1", "description": "Keep request", "intake": "general"}, worker)
        with core.transaction() as connection:
            connection.execute("UPDATE users SET shift_id=NULL,department=NULL,display_name='Мастер цеха',modules_json='[\"journal\",\"fleet\"]' WHERE id=?", (worker["id"],))
            connection.execute("ALTER TABLE users DROP COLUMN shift_id")
            connection.execute("DROP TABLE work_shifts")
            connection.execute("DELETE FROM app_meta WHERE key='shift_profiles_v1'")
            connection.execute("UPDATE app_meta SET value='1' WHERE key='schema_version'")
            connection.execute("INSERT INTO repair_history(id,board,work_date,department,description,created_at,updated_at) VALUES('old-history','TEST-1','2026-09-30',?,'Keep history',?,?)", (core.TO_DEPARTMENT, core.now_iso(), core.now_iso()))
        core.initialize_database()
        core.initialize_database()
        with core.connect() as connection:
            restored = dict(connection.execute("SELECT * FROM users WHERE id=?", (worker["id"],)).fetchone())
            self.assertTrue(core.verify_password(restored, "test-profile-only"))
            self.assertEqual(restored["department"], core.TO_DEPARTMENT)
            self.assertIsNone(restored["shift_id"])
            self.assertEqual(json.loads(restored["modules_json"]).count("shifts"), 1)
            self.assertIsNotNone(connection.execute("SELECT 1 FROM requests WHERE id=?", (request["id"],)).fetchone())
            self.assertEqual(connection.execute("SELECT count(*) FROM repair_history").fetchone()[0], 1)
        backups = list((core.DATA_DIR / "migration-backups").glob("*.sqlite"))
        self.assertEqual(len(backups), 1)
        with sqlite3.connect(backups[0]) as backup:
            self.assertNotIn("shift_id", [row[1] for row in backup.execute("PRAGMA table_info(users)")])

    def test_http_login_shift_selection_and_locked_sections(self):
        self.profile("master", "day_1")
        self.profile("master", "night_1")
        httpd = server.EstuServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        def request(method, route, body=None, cookie=""):
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port)
            connection.request(method, route, json.dumps(body) if body is not None else None,
                               {"Content-Type": "application/json", "Cookie": cookie})
            response = connection.getresponse()
            status, headers, content = response.status, dict(response.getheaders()), response.read()
            connection.close()
            return status, headers, json.loads(content) if content else None
        try:
            status, _, auth = request("GET", "/api/auth/status")
            self.assertEqual(status, 200)
            self.assertEqual(len(auth["shiftSchedule"]["shifts"]), 4)
            status, headers, result = request("POST", "/api/auth/block-login", {"scope": "master", "shiftId": "night_1", "password": "test-profile-only"})
            self.assertEqual(status, 200)
            self.assertEqual(result["user"]["shiftId"], "night_1")
            cookie = headers["Set-Cookie"].split(";")[0]
            self.assertEqual(request("GET", "/api/shifts?from=2026-10-01&days=4", cookie=cookie)[0], 200)
            self.assertEqual(request("GET", "/api/users", cookie=cookie)[0], 403)
            self.assertEqual(request("PUT", "/api/shifts", DEFAULT_SETTINGS, cookie)[0], 403)
            self.assertEqual(request("POST", "/api/auth/block-login", {"scope": "master", "password": "test-profile-only"})[0], 401)
            for scope in ("pto", "maintenance"):
                self.assertEqual(request("POST", "/api/auth/block-login", {"scope": scope, "password": "test-only"})[0], 501)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main(verbosity=2)
