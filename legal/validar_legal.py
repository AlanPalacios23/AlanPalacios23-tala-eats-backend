#!/usr/bin/env python3
"""Validación offline: bloquea publicación incompleta y no hace peticiones externas."""
from pathlib import Path
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parent
PAGES = (ROOT / "site/privacidad/index.html", ROOT / "site/eliminar-cuenta/index.html")
REQUIRED = ("__RESPONSABLE_LEGAL__", "__DOMICILIO_LEGAL__", "__CORREO_PRIVACIDAD__")

class CheckHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.headers = []
        self.lang = False
    def handle_starttag(self, tag, attrs):
        att = dict(attrs)
        if tag == "html" and att.get("lang") == "es-MX":
            self.lang = True
        if tag in ("h1", "main"):
            self.headers.append(tag)

def main():
    errors = []
    for page in PAGES:
        if not page.is_file():
            errors.append(f"{page}: archivo faltante")
            continue
        content = page.read_text(encoding="utf-8")
        for token in REQUIRED:
            if token in content:
                errors.append(f"{page}: FALTA reemplazar {token}")
        if "<script" in content.lower() or "<iframe" in content.lower():
            errors.append(f"{page}: no se permiten scripts ni iframes")
        if "mailto:" not in content:
            errors.append(f"{page}: falta canal de contacto")
        parser = CheckHTML()
        parser.feed(content)
        if not parser.lang or "h1" not in parser.headers or "main" not in parser.headers:
            errors.append(f"{page}: estructura accesible incompleta")
        print(f"REVISADO {page.relative_to(ROOT)}")
    if errors:
        print("\n".join("BLOQUEO: " + err for err in errors))
        raise SystemExit(2)
    print("LEGAL_OFFLINE_PASS: quedan verificación legal, contacto y pruebas externas")

if __name__ == "__main__":
    main()
