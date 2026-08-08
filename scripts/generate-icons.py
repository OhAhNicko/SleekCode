#!/usr/bin/env python3
"""Regenerate the MADE desktop icon set from src-tauri/icons/made-logo.svg.

macOS only. Zero third-party dependencies: uses Google Chrome (headless) as the
SVG rasterizer and the Python standard library for PNG/ICO/ICNS packing.

Usage:  python3 scripts/generate-icons.py [--svg PATH] [--out DIR] [--check]
"""
import argparse, os, shutil, struct, subprocess, sys, tempfile, time, zlib

PNG_SIG = b"\x89PNG\r\n\x1a\n"

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
]

CHROME_FLAGS = [
    "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--disable-default-apps", "--mute-audio",
    "--force-device-scale-factor=1", "--default-background-color=00000000",
]


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    p = shutil.which("google-chrome") or shutil.which("chromium")
    if p:
        return p
    sys.exit("ERROR: no Chrome/Chromium found. Install Google Chrome.")


# ---------------------------------------------------------------- rasterizing
def render_page(chrome, workdir, profile, name, body, w, h, out_path, timeout=60.0):
    """Screenshot an HTML fragment at exactly w x h.

    Chrome 132+ headless writes the screenshot but does not exit, so poll for a
    complete PNG (trailing IEND chunk) and then terminate the process.
    """
    html = os.path.join(workdir, name)
    with open(html, "w", encoding="utf-8") as f:
        f.write("<!doctype html><meta charset=utf-8>" + body)
    if os.path.exists(out_path):
        os.remove(out_path)
    proc = subprocess.Popen(
        [chrome] + CHROME_FLAGS
        + ["--window-size=%d,%d" % (w, h),
           "--screenshot=" + out_path,
           "--user-data-dir=" + profile,
           "file://" + html],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + timeout
    ok = False
    try:
        while time.time() < deadline:
            if os.path.exists(out_path) and os.path.getsize(out_path) > 12:
                with open(out_path, "rb") as f:
                    f.seek(-12, os.SEEK_END)
                    if f.read(12)[4:8] == b"IEND":
                        ok = True
                        break
            if proc.poll() is not None and os.path.getsize(out_path or "") == 0:
                break
            time.sleep(0.05)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    if not ok:
        sys.exit("ERROR: Chrome did not produce %s" % out_path)
    rw, rh, _ = read_png(out_path)
    if (rw, rh) != (w, h):
        sys.exit("ERROR: %s is %dx%d, expected %dx%d" % (out_path, rw, rh, w, h))


def render(chrome, workdir, profile, svg_name, size, out_path, timeout=60.0):
    """Screenshot the SVG at exactly size x size with a transparent backdrop.

    Feeding Chrome the SVG directly would render it at its intrinsic size and
    leave the rest of the window transparent, so it goes through an <img> sized
    in CSS instead.
    """
    render_page(
        chrome, workdir, profile, "wrap-%d.html" % size,
        "<style>html,body{margin:0;padding:0;background:transparent}"
        "img{display:block;width:%dpx;height:%dpx}</style>"
        '<img src="%s">' % (size, size, svg_name),
        size, size, out_path, timeout,
    )


# ------------------------------------------------------------------ png codec
def read_png(path):
    """Decode an 8-bit non-interlaced PNG to (w, h, RGBA bytes)."""
    d = open(path, "rb").read()
    if d[:8] != PNG_SIG:
        raise ValueError("not a PNG: %s" % path)
    pos, idat, hdr, plte, trns = 8, [], None, None, None
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ, body = d[pos + 4:pos + 8], d[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            hdr = struct.unpack(">IIBBBBB", body)
        elif typ == b"IDAT":
            idat.append(body)
        elif typ == b"PLTE":
            plte = body
        elif typ == b"tRNS":
            trns = body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    w, h, bd, ct, _, _, inter = hdr
    if bd != 8 or inter != 0:
        raise ValueError("unsupported PNG (bitdepth=%d interlace=%d)" % (bd, inter))
    nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    stride = w * nch
    raw = zlib.decompress(b"".join(idat))
    out, prev, pos = bytearray(stride * h), bytes(stride), 0
    for y in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b, c = prev[i], (prev[i - nch] if i >= nch else 0)
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        elif f != 0:
            raise ValueError("bad filter type %d" % f)
        out[y * stride:(y + 1) * stride] = line
        prev = bytes(line)
    rgba = bytearray(w * h * 4)
    if ct == 6:
        rgba[:] = out
    elif ct == 2:
        for p in range(w * h):
            s, t = p * 3, p * 4
            rgba[t:t + 3] = out[s:s + 3]; rgba[t + 3] = 255
    elif ct == 4:
        for p in range(w * h):
            s, t = p * 2, p * 4
            v = out[s]; rgba[t] = rgba[t + 1] = rgba[t + 2] = v; rgba[t + 3] = out[s + 1]
    elif ct == 0:
        for p in range(w * h):
            v = out[p]; t = p * 4
            rgba[t] = rgba[t + 1] = rgba[t + 2] = v; rgba[t + 3] = 255
    elif ct == 3:
        for p in range(w * h):
            idx = out[p]; t, s = p * 4, out[p] * 3
            rgba[t:t + 3] = plte[s:s + 3]
            rgba[t + 3] = trns[idx] if (trns and idx < len(trns)) else 255
    return w, h, bytes(rgba)


def _chunk(typ, body):
    return (struct.pack(">I", len(body)) + typ + body
            + struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF))


def encode_png(w, h, rgba):
    """RGBA8 -> PNG bytes. Filter 0 + zlib 9 beats adaptive filtering on
    smooth-gradient artwork (measured: 465 KB vs 590 KB at 1024x1024)."""
    stride = w * 4
    raw = b"".join(b"\x00" + rgba[y * stride:(y + 1) * stride] for y in range(h))
    return (PNG_SIG
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(raw, 9))
            + _chunk(b"IEND", b""))


def halve(w, h, src):
    """Exact 2x2 box average in premultiplied space (w and h must be even)."""
    n, m = w // 2, h // 2
    out = bytearray(n * m * 4)
    for oy in range(m):
        r0, r1 = (2 * oy) * w * 4, (2 * oy + 1) * w * 4
        for ox in range(n):
            i0 = r0 + 8 * ox; i1 = i0 + 4
            i2 = r1 + 8 * ox; i3 = i2 + 4
            a0, a1, a2, a3 = src[i0 + 3], src[i1 + 3], src[i2 + 3], src[i3 + 3]
            asum = a0 + a1 + a2 + a3
            t = (oy * n + ox) * 4
            if asum:
                out[t] = (src[i0] * a0 + src[i1] * a1 + src[i2] * a2 + src[i3] * a3 + asum // 2) // asum
                out[t + 1] = (src[i0 + 1] * a0 + src[i1 + 1] * a1 + src[i2 + 1] * a2 + src[i3 + 1] * a3 + asum // 2) // asum
                out[t + 2] = (src[i0 + 2] * a0 + src[i1 + 2] * a1 + src[i2 + 2] * a2 + src[i3 + 2] * a3 + asum // 2) // asum
                out[t + 3] = (asum + 2) // 4
    return n, m, bytes(out)


# ------------------------------------------------------------------- ico/icns
def build_ico(blobs):
    """Pack PNG blobs into an ICO. Mirrors the layout tauri's ico writer emits:
    all entries PNG-compressed, planes=0, bpp=32, 256 encoded as 0."""
    ent = []
    for b in blobs:
        if b[:8] != PNG_SIG or b[12:16] != b"IHDR":
            raise ValueError("ICO entry is not a PNG")
        w, h = struct.unpack(">II", b[16:24])
        if not (1 <= w <= 256 and 1 <= h <= 256):
            raise ValueError("ICO entries must be <= 256px, got %dx%d" % (w, h))
        ent.append((w, h, b))
    off = 6 + 16 * len(ent)
    hdr, data = [], []
    for w, h, b in ent:
        hdr.append(struct.pack("<BBBBHHII", 0 if w == 256 else w, 0 if h == 256 else h,
                               0, 0, 0, 32, len(b), off))
        data.append(b); off += len(b)
    return struct.pack("<HHH", 0, 1, len(ent)) + b"".join(hdr) + b"".join(data)


ICNS_TYPES = [(b"ic11", 32), (b"ic12", 64), (b"ic07", 128), (b"ic13", 256),
              (b"ic08", 256), (b"ic14", 512), (b"ic09", 512), (b"ic10", 1024)]


def build_icns(blobs_by_size):
    """Write an .icns directly so the PNG payloads stay as encoded here.
    (iconutil re-encodes through ImageIO and inflates the file ~2.6x.)"""
    body = b""
    for ostype, size in ICNS_TYPES:
        b = blobs_by_size[size]
        body += ostype + struct.pack(">I", len(b) + 8) + b
    return b"icns" + struct.pack(">I", len(body) + 8) + body


# -------------------------------------------------------- NSIS installer bitmaps
def build_bmp(w, h, rgba, bg):
    """RGBA8 -> uncompressed 24-bit BMP. NSIS accepts nothing else: no alpha
    channel, no compression, rows bottom-up, each row padded to 4 bytes."""
    row = (w * 3 + 3) & ~3
    pixels = row * h
    out = bytearray(54 + pixels)
    out[0:2] = b"BM"
    struct.pack_into("<IHHI", out, 2, 54 + pixels, 0, 0, 54)
    struct.pack_into("<IiiHHIIiiII", out, 14, 40, w, h, 1, 24, 0, pixels,
                     2835, 2835, 0, 0)
    br, bgc, bb = bg
    for y in range(h):
        src = (h - 1 - y) * w * 4
        dst = 54 + y * row
        for x in range(w):
            s, d = src + x * 4, dst + x * 3
            a = rgba[s + 3]
            if a == 255:
                out[d], out[d + 1], out[d + 2] = rgba[s + 2], rgba[s + 1], rgba[s]
            else:
                out[d] = (rgba[s + 2] * a + bb * (255 - a) + 127) // 255
                out[d + 1] = (rgba[s + 1] * a + bgc * (255 - a) + 127) // 255
                out[d + 2] = (rgba[s] * a + br * (255 - a) + 127) // 255
    return bytes(out)


# Heads surface tokens, mirrored from headsTheme.surface in src/lib/themes.ts.
BG_HEX, ACCENT, TEXT_MUTED = "#131313", "#80e2ad", "#8a8a8a"
BG_RGB = (0x13, 0x13, 0x13)
FONT = "'Segoe UI',Helvetica,Arial,sans-serif"


def app_version(repo_root):
    """Read version from package.json without importing json's cost of being
    wrong — the installer sidebar used to hardcode v0.1.0 and drifted 9 releases
    behind before anyone noticed."""
    import json
    with open(os.path.join(repo_root, "package.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def gen_installer_bitmaps(chrome, tmp, profile, outdir, version):
    """Regenerate the two NSIS branding bitmaps from the same SVG as the icons.

    tauri.conf.json points nsis.headerImage/sidebarImage at these, so an icon
    change that skips them ships an installer wearing the previous logo.
    """
    os.makedirs(outdir, exist_ok=True)

    # Sidebar: 164x314, Heads canvas, mark over the wordmark.
    #
    # Everything here is laid out IN FLOW on purpose. Chrome's headless
    # --screenshot does not paint out-of-flow boxes: an absolutely- or
    # fixed-positioned element renders as nothing at all, silently, whatever
    # colour it is. The version stamp used to be `position:absolute;bottom:18px`
    # and was simply missing from the bitmap. Keep the footer as a flex child.
    sidebar = (
        "<style>html,body{margin:0;padding:0;width:164px;height:314px;"
        "background:%s;font-family:%s;-webkit-font-smoothing:antialiased}"
        ".w{height:100%%;display:flex;flex-direction:column}"
        ".m{flex:1;display:flex;flex-direction:column;align-items:center;"
        "justify-content:center;gap:14px}"
        "img{width:100px;height:100px;display:block}"
        ".n{font-size:22px;font-weight:700;color:%s;letter-spacing:.02em}"
        ".s{font-size:11px;color:%s}"
        ".r{width:80px;height:1px;background:%s;opacity:.4}"
        ".v{text-align:center;font-size:10px;color:%s;padding-bottom:18px}</style>"
        '<div class="w"><div class="m"><img src="src.svg"><div class="n">MADE</div>'
        '<div class="s">AI Terminal Workspace</div><div class="r"></div></div>'
        '<div class="v">v%s</div></div>'
        % (BG_HEX, FONT, ACCENT, TEXT_MUTED, ACCENT, TEXT_MUTED, version)
    )
    p = os.path.join(tmp, "sidebar.png")
    render_page(chrome, tmp, profile, "sidebar.html", sidebar, 164, 314, p)
    w, h, rgba = read_png(p)
    open(os.path.join(outdir, "sidebar.bmp"), "wb").write(build_bmp(w, h, rgba, BG_RGB))
    print("  %-16s %3dx%-3d %8d bytes" % ("sidebar.bmp", w, h, 54 + ((w * 3 + 3) & ~3) * h))

    # Header: 150x57. Stays white — it sits in NSIS's own light page chrome,
    # and a dark strip there reads as a rendering fault, not as branding.
    header = (
        "<style>html,body{margin:0;padding:0;width:150px;height:57px;"
        "background:#ffffff;display:flex;align-items:center;justify-content:center}"
        "img{width:44px;height:44px;display:block}</style>"
        '<img src="src.svg">'
    )
    p = os.path.join(tmp, "header.png")
    render_page(chrome, tmp, profile, "header.html", header, 150, 57, p)
    w, h, rgba = read_png(p)
    open(os.path.join(outdir, "header.bmp"), "wb").write(build_bmp(w, h, rgba, (255, 255, 255)))
    print("  %-16s %3dx%-3d %8d bytes" % ("header.bmp", w, h, 54 + ((w * 3 + 3) & ~3) * h))


def verify_bmp(path, w, h):
    d = open(path, "rb").read()
    assert d[:2] == b"BM", "%s: bad BMP magic" % path
    size, off = struct.unpack("<I", d[2:6])[0], struct.unpack("<I", d[10:14])[0]
    hdr, bw, bh, planes, bpp, comp = struct.unpack("<IiiHHI", d[14:34])
    assert size == len(d), "%s: size field %d != %d" % (path, size, len(d))
    assert (bw, bh) == (w, h), "%s: %dx%d, expected %dx%d" % (path, bw, bh, w, h)
    assert hdr == 40 and planes == 1 and bpp == 24 and comp == 0, \
        "%s: NSIS needs an uncompressed 24-bit BITMAPINFOHEADER" % path
    assert off + ((bw * 3 + 3) & ~3) * bh == len(d), "%s: pixel data truncated" % path
    return "%dx%d %d-bit" % (bw, bh, bpp)


# ---------------------------------------------------------------- verification
def verify_ico(path):
    d = open(path, "rb").read()
    res, typ, cnt = struct.unpack("<HHH", d[:6])
    assert res == 0 and typ == 1 and cnt > 0, "bad ICONDIR"
    covered = set(range(0, 6 + 16 * cnt))
    seen = []
    for i in range(cnt):
        o = 6 + i * 16
        bw, bh, _, _, _, bpp, size, off = struct.unpack("<BBBBHHII", d[o:o + 16])
        w, h = bw or 256, bh or 256
        blob = d[off:off + size]
        assert blob[:8] == PNG_SIG, "entry %d not PNG" % i
        rw, rh = struct.unpack(">II", blob[16:24])
        assert (rw, rh) == (w, h), "entry %d size mismatch" % i
        p = 8
        while p < len(blob):
            ln = struct.unpack(">I", blob[p:p + 4])[0]
            t, bd = blob[p + 4:p + 8], blob[p + 8:p + 8 + ln]
            crc = struct.unpack(">I", blob[p + 8 + ln:p + 12 + ln])[0]
            assert crc == (zlib.crc32(t + bd) & 0xFFFFFFFF), "CRC fail"
            p += 12 + ln
        covered |= set(range(off, off + size))
        seen.append(w)
    assert covered == set(range(len(d))), "ICO has gaps or overlapping entries"
    return seen


def verify_icns(path):
    d = open(path, "rb").read()
    assert d[:4] == b"icns", "bad icns magic"
    total = struct.unpack(">I", d[4:8])[0]
    assert total == len(d), "icns size field %d != file size %d" % (total, len(d))
    pos, seen = 8, []
    while pos < len(d):
        t = d[pos:pos + 4]
        ln = struct.unpack(">I", d[pos + 4:pos + 8])[0]
        assert 8 < ln <= len(d) - pos, "bad chunk length for %r" % t
        payload = d[pos + 8:pos + ln]
        assert payload[:8] == PNG_SIG, "%r payload is not PNG" % t
        w, h = struct.unpack(">II", payload[16:24])
        seen.append((t.decode(), w))
        pos += ln
    return seen


# --------------------------------------------------------------------- driver
def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    # Variant C ("Stacked panes") is the app's identity since 2026-08: the
    # Appearance > App icon picker defaults to it and the Windows identity
    # files (icon.ico + flat PNGs) were regenerated from it. made-logo.svg is
    # the RETIRED tile-grid logo — pointing this back at it would silently
    # revert the exe/shortcut icon on the next run.
    ap.add_argument("--svg", default=os.path.join(here, "src-tauri/icons/variants/icon-c.svg"))
    ap.add_argument("--out", default=os.path.join(here, "src-tauri/icons"))
    ap.add_argument("--installer-out",
                    default=os.path.join(here, "src-tauri/installer-assets"))
    ap.add_argument("--skip-installer", action="store_true",
                    help="only regenerate the icon set, leave the NSIS bitmaps")
    args = ap.parse_args()

    if sys.platform != "darwin":
        print("warning: tested on macOS only", file=sys.stderr)
    svg = os.path.abspath(args.svg)
    out = os.path.abspath(args.out)
    if not os.path.exists(svg):
        sys.exit("ERROR: missing %s" % svg)
    os.makedirs(out, exist_ok=True)
    chrome = find_chrome()
    print("rasterizer: %s" % chrome)

    tmp = tempfile.mkdtemp(prefix="made-icons-")
    try:
        shutil.copy2(svg, os.path.join(tmp, "src.svg"))
        profile = os.path.join(tmp, "chrome-profile")
        px = {}

        # Render at 2x the largest target, then build an exact box-filter mip
        # chain. Supersampling cancels Chrome's gradient dithering (1024 PNG:
        # 152 KB supersampled vs 273 KB rendered directly) and matches an ideal
        # area-average downscale.
        t0 = time.time()
        big = os.path.join(tmp, "r2048.png")
        render(chrome, tmp, profile, "src.svg", 2048, big)
        w, h, buf = read_png(big)
        while w > 16:
            w, h, buf = halve(w, h, buf)
            px[w] = buf
        # 24 and 48 are not on the 2048 mip chain; render them at 2x too.
        for target in (24, 48):
            p = os.path.join(tmp, "r%d.png" % (target * 2))
            render(chrome, tmp, profile, "src.svg", target * 2, p)
            ww, hh, bb = read_png(p)
            ww, hh, bb = halve(ww, hh, bb)
            px[ww] = bb
        print("rendered in %.1fs: %s" % (time.time() - t0, sorted(px)))

        blob = {s: encode_png(s, s, px[s]) for s in sorted(px)}

        # flat PNGs consumed by tauri.conf.json bundle.icon (+ the extras that
        # `tauri icon` also emits and that this repo already tracks)
        flat = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256,
                "64x64.png": 64, "icon.png": 512, "made-1024.png": 1024}
        for name, size in flat.items():
            open(os.path.join(out, name), "wb").write(blob[size])
            print("  %-16s %5d px  %8d bytes" % (name, size, len(blob[size])))

        icns = build_icns(blob)
        open(os.path.join(out, "icon.icns"), "wb").write(icns)
        print("  %-16s %8d bytes" % ("icon.icns", len(icns)))

        # entry order matches the icon.ico this repo already ships
        ico = build_ico([blob[s] for s in (32, 16, 24, 48, 64, 256)])
        open(os.path.join(out, "icon.ico"), "wb").write(ico)
        print("  %-16s %8d bytes" % ("icon.ico", len(ico)))

        # The favicon is the SVG itself, served from public/. Copying it here
        # rather than hand-maintaining a second file is what keeps index.html's
        # icon from drifting away from the app icon (it pointed at Vite's stock
        # logo for the whole life of the project before this).
        fav = os.path.join(here, "public", "made-logo.svg")
        os.makedirs(os.path.dirname(fav), exist_ok=True)
        shutil.copy2(svg, fav)
        print("  %-16s %8d bytes" % ("public/made-logo.svg", os.path.getsize(fav)))

        if not args.skip_installer:
            inst = os.path.abspath(args.installer_out)
            gen_installer_bitmaps(chrome, tmp, profile, inst, app_version(here))

        print("verify icon.ico  -> entries %s" % verify_ico(os.path.join(out, "icon.ico")))
        print("verify icon.icns -> chunks %s" % verify_icns(os.path.join(out, "icon.icns")))
        if not args.skip_installer:
            print("verify sidebar.bmp -> %s" % verify_bmp(os.path.join(inst, "sidebar.bmp"), 164, 314))
            print("verify header.bmp  -> %s" % verify_bmp(os.path.join(inst, "header.bmp"), 150, 57))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("done")


if __name__ == "__main__":
    main()
