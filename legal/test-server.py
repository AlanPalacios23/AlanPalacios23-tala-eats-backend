#!/usr/bin/env python3
"""Local-only tests: service returns pages, HEAD, and no other customer routes."""
import importlib.util
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request, urlopen

MODULE_PATH=Path(__file__).with_name("server.py")
spec=importlib.util.spec_from_file_location("tala_legal_server",MODULE_PATH)
assert spec and spec.loader
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with TemporaryDirectory() as d:
    privacy=Path(d)/"privacy.html"
    deletion=Path(d)/"delete.html"
    privacy.write_text("<html lang='es-MX'>Privacidad Tala Eats</html>", encoding="utf-8")
    deletion.write_text("<html lang='es-MX'>Eliminar cuenta Tala Eats</html>", encoding="utf-8")
    module.ALLOWED={"/privacidad":privacy,"/privacidad/":privacy,
                    "/eliminar-cuenta":deletion,"/eliminar-cuenta/":deletion}
    server=ThreadingHTTPServer(("127.0.0.1",0),module.LegalHandler)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        base="http://127.0.0.1:"+str(server.server_address[1])
        for path,expected in (("/privacidad","Privacidad"),
                              ("/eliminar-cuenta","Eliminar cuenta"),
                              ("/privacidad/","Privacidad"),
                              ("/eliminar-cuenta/","Eliminar cuenta")):
            with urlopen(base+path,timeout=3) as response:
                assert response.status==200, path
                assert expected in response.read().decode("utf-8"),path
                assert response.headers.get_content_type()=="text/html"
                assert response.headers.get("X-Content-Type-Options")=="nosniff"
            with urlopen(Request(base+path,method="HEAD"),timeout=3) as response:
                assert response.status==200
                assert response.read()==b""
        for path in ("/api/v1/health","/","/../../etc/passwd","/privacidad/private"):
            try:
                urlopen(base+path,timeout=3)
            except HTTPError as error:
                assert error.code==404, path
            else:
                raise AssertionError("Unexpected page exposure: "+path)
        print("LEGAL_LOOPBACK_HTTP_TEST_PASS")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
