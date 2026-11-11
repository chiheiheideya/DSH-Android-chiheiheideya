#!/usr/bin/env python3
"""Deterministic zip of a directory tree: sorted entries, fixed timestamps,
unix permission bits preserved, regular files and directories only (symlinks
are rejected). Usage: make-zip.py <src-dir> <out.zip>"""
import os
import stat
import sys
import zipfile

FIXED_TIME = (2025, 1, 1, 0, 0, 0)


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    entries = []
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            entries.append(os.path.join(root, name))
    entries.sort(key=lambda p: os.path.relpath(p, src))
    tmp = out + '.partial'
    with zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in entries:
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode):
                raise SystemExit(f'symlink in engine tree: {path}')
            if not stat.S_ISREG(st.st_mode):
                raise SystemExit(f'non-regular file in engine tree: {path}')
            rel = os.path.relpath(path, src).replace(os.sep, '/')
            info = zipfile.ZipInfo(rel, FIXED_TIME)
            mode = 0o755 if st.st_mode & 0o111 else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            with open(path, 'rb') as fh:
                zf.writestr(info, fh.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    os.replace(tmp, out)


if __name__ == '__main__':
    main()
