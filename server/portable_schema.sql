PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_shifts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('day','night')),
  team INTEGER NOT NULL CHECK (team IN (1,2))
);

INSERT OR IGNORE INTO work_shifts(id,name,kind,team) VALUES
  ('day_1','Дневная смена №1','day',1),
  ('day_2','Дневная смена №2','day',2),
  ('night_1','Ночная смена №1','night',1),
  ('night_2','Ночная смена №2','night',2);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash BLOB NOT NULL,
  password_salt BLOB NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 120000,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','executor')),
  access_scope TEXT,
  department TEXT,
  modules_json TEXT,
  permissions_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  shift_id TEXT REFERENCES work_shifts(id),
  FOREIGN KEY (department) REFERENCES departments(name) ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fleet (
  board TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL,
  model TEXT,
  department TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('new','waiting','in_progress')),
  assigned_user_id TEXT,
  created_by_user_id TEXT,
  updated_at TEXT NOT NULL,
  external_source TEXT,
  external_id TEXT,
  FOREIGN KEY (board) REFERENCES fleet(board) ON UPDATE CASCADE,
  FOREIGN KEY (department) REFERENCES departments(name) ON UPDATE CASCADE,
  FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_requests_external
  ON requests(external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS repair_history (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL,
  model TEXT,
  work_date TEXT NOT NULL,
  department TEXT NOT NULL,
  description TEXT NOT NULL,
  work_done TEXT,
  note TEXT,
  source TEXT,
  external_source TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_by_user_id TEXT,
  FOREIGN KEY (board) REFERENCES fleet(board) ON UPDATE CASCADE,
  FOREIGN KEY (department) REFERENCES departments(name) ON UPDATE CASCADE,
  FOREIGN KEY (completed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_history_external
  ON repair_history(external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS navigation_equipment (
  board TEXT PRIMARY KEY,
  informer_type TEXT NOT NULL CHECK (informer_type IN ('Селена','Искра','ИР')),
  has_navigator INTEGER NOT NULL DEFAULT 0,
  is_ai_orbita INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT,
  FOREIGN KEY (board) REFERENCES fleet(board) ON UPDATE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bso_board_notes (
  board TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (board) REFERENCES fleet(board) ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS bso_devices (
  board TEXT NOT NULL,
  device_type TEXT NOT NULL CHECK (device_type IN ('cash','cube')),
  slot INTEGER NOT NULL,
  full_number TEXT,
  short_number TEXT,
  status TEXT NOT NULL DEFAULT 'empty' CHECK (status IN ('installed','removed','empty')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (board, device_type, slot),
  FOREIGN KEY (board) REFERENCES fleet(board) ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bso_full_number
  ON bso_devices(full_number) WHERE full_number IS NOT NULL AND full_number <> '';
CREATE UNIQUE INDEX IF NOT EXISTS ux_bso_short_number
  ON bso_devices(short_number) WHERE short_number IS NOT NULL AND short_number <> '';

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS yandex_checkpoints (
  source_key TEXT PRIMARY KEY,
  last_answer_id TEXT,
  last_sync_at TEXT,
  last_imported_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS nav_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('morning','evening')),
  source TEXT NOT NULL CHECK (source IN ('manual','email')),
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  email_uid INTEGER,
  email_subject TEXT NOT NULL DEFAULT '',
  email_from TEXT NOT NULL DEFAULT '',
  email_date TEXT,
  imported_at TEXT NOT NULL,
  imported_by_user_id TEXT,
  warning TEXT NOT NULL DEFAULT '',
  detection_reason TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (sha256, period, report_date),
  FOREIGN KEY (imported_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_nav_active_period
  ON nav_reports(report_date, period) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS nav_observations (
  report_id INTEGER NOT NULL,
  board TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  raw_row INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, board),
  FOREIGN KEY (report_id) REFERENCES nav_reports(id) ON DELETE CASCADE,
  FOREIGN KEY (board) REFERENCES fleet(board) ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS nav_mail_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  imap_host TEXT NOT NULL DEFAULT '',
  imap_port INTEGER NOT NULL DEFAULT 993,
  use_ssl INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL DEFAULT '',
  password_protected TEXT NOT NULL DEFAULT '',
  mail_folder TEXT NOT NULL DEFAULT 'INBOX',
  sender_filter TEXT NOT NULL DEFAULT '',
  subject_filter TEXT NOT NULL DEFAULT 'User metro',
  depot_name TEXT NOT NULL DEFAULT 'Троллейбусное Депо №2',
  poll_minutes INTEGER NOT NULL DEFAULT 5,
  morning_cutoff_hour INTEGER NOT NULL DEFAULT 12,
  auto_sync INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS nav_mail_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mailbox_key TEXT NOT NULL DEFAULT '',
  last_uid INTEGER NOT NULL DEFAULT 0,
  last_check_at TEXT,
  last_success_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  last_imported_count INTEGER NOT NULL DEFAULT 0,
  trigger_requested INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nav_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','success','warning','error')),
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nav_attention_cases (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  opened_report_date TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  red_percent REAL NOT NULL DEFAULT 0,
  yellow_percent REAL NOT NULL DEFAULT 0,
  red_streak INTEGER NOT NULL DEFAULT 0,
  healthy_streak INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_evaluated_at TEXT NOT NULL,
  last_report_date TEXT NOT NULL,
  closed_at TEXT,
  closed_reason TEXT,
  closed_by_user_id TEXT,
  FOREIGN KEY (board) REFERENCES fleet(board) ON UPDATE CASCADE,
  FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_nav_attention_active_board
  ON nav_attention_cases(board) WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS ix_requests_created_at ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_requests_board ON requests(board);
CREATE INDEX IF NOT EXISTS ix_history_work_date ON repair_history(work_date DESC);
CREATE INDEX IF NOT EXISTS ix_history_board ON repair_history(board);
CREATE INDEX IF NOT EXISTS ix_audit_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_nav_reports_date ON nav_reports(report_date DESC, period, is_active);
CREATE INDEX IF NOT EXISTS ix_nav_observations_board ON nav_observations(board, report_id);

INSERT OR IGNORE INTO nav_mail_config(id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%S','now'));
INSERT OR IGNORE INTO nav_mail_state(id) VALUES (1);
INSERT OR IGNORE INTO app_meta(key, value) VALUES ('schema_version', '1');
