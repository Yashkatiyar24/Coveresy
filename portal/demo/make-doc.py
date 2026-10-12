#!/usr/bin/env python3
"""Generate a small, valid single-page PDF so demo attachments open as real
documents rather than dummy bytes. No dependencies."""
import sys

def pdf(title, lines):
    def esc(s):
        return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')

    content = ["BT", "/F1 18 Tf", "72 720 Td", f"({esc(title)}) Tj", "/F1 11 Tf"]
    for ln in lines:
        content += ["0 -22 Td", f"({esc(ln)}) Tj"]
    content.append("ET")
    stream = "\n".join(content).encode("latin-1", "replace")

    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"

    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n".encode())
    out += b"%%EOF\n"
    return bytes(out)

if __name__ == "__main__":
    title = sys.argv[1]
    body = sys.argv[2:-1]
    with open(sys.argv[-1], "wb") as f:
        f.write(pdf(title, body))
