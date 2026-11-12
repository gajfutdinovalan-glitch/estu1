import http.client
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portable_server as server


class FrontendDeliveryTests(unittest.TestCase):
    def test_public_files_and_module_mime(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(server, 'LOG_PATH', Path(temp) / 'http.log'):
            httpd = server.EstuServer(('127.0.0.1', 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            client = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
            try:
                client.request('GET', '/')
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn(b'type="module"', response.read())

                client.request('GET', '/frontend/main.js')
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader('Content-Type'), 'application/javascript; charset=utf-8')
                response.read()

                client.request('GET', '/server/portable_server.py')
                response = client.getresponse()
                self.assertEqual(response.status, 404)
                response.read()
            finally:
                client.close()
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=5)
