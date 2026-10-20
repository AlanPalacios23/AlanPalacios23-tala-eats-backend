#!/usr/bin/env python3
"""Restore encrypted-media TAR to an isolated temporary directory, no live writes."""
from __future__ import annotations

import argparse
import pathlib
import sys
import tarfile
import tempfile

MAX_TOTAL_BYTES = 4 * 1024**3
MAX_ENTRIES = 100000


def safe_path(name: str) -> pathlib.PurePosixPath:
    p = pathlib.PurePosixPath(name)
    if p.is_absolute() or ".." in p.parts or not p.parts or "\x00" in name:
        raise ValueError("Ruta insegura en TAR: se rechazó el ensayo")
    parts = tuple(piece for piece in p.parts if piece not in ("", "."))
    if not parts:
        return pathlib.PurePosixPath(".")
    return pathlib.PurePosixPath(*parts)


def restore_stream() -> None:
    count, files, total = 0, 0, 0
    with tempfile.TemporaryDirectory(prefix="tala-restore-media-") as tmp:
        root = pathlib.Path(tmp).resolve()
        with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
            for member in archive:
                count += 1
                if count > MAX_ENTRIES:
                    raise ValueError("Demasiadas entradas de media")
                path = safe_path(member.name)
                target = root.joinpath(*path.parts)
                if not target.resolve().is_relative_to(root):
                    raise ValueError("Ruta fuera del destino temporal")
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    raise ValueError("Entrada TAR insegura: link/dispositivo/especial")
                total += member.size
                if member.size < 0 or total > MAX_TOTAL_BYTES:
                    raise ValueError("Media TAR excede límites")
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("Archivo incompleto en TAR")
                with target.open("xb") as dest:
                    remaining = member.size
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("Media truncada")
                        dest.write(chunk)
                        remaining -= len(chunk)
                if target.stat().st_size != member.size:
                    raise ValueError("Media incompleta tras extracción")
                files += 1
        if count == 0:
            raise ValueError("Media TAR vacía")
        print(f"KALI_MEDIA_TEMP_RESTORE_PASS entries={count} files={files} bytes={total}")
        # All extracted media gets removed automatically with TemporaryDirectory.


def self_test():
    for invalid in ("../../etc/passwd", "/app/media", "../media", "media/../etc",
                    ""):
        try:
            safe_path(invalid)
        except ValueError:
            continue
        raise AssertionError("Se aceptó ruta TAR insegura")
    assert str(safe_path("./media/imagen.png")) == "media/imagen.png"
    print("KALI_MEDIA_RESTORE_GUARDS_PASS")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        self_test() if args.self_test else restore_stream()
    except (OSError, ValueError, tarfile.TarError) as exc:
        print("KALI_MEDIA_RESTORE_BLOCKED:", str(exc), file=sys.stderr)
        sys.exit(2)
