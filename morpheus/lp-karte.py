#!/usr/bin/python3
"""lp-karte (Morpheus, 06.11.2026): find the Android partitions in the super area of ANY Duo.

android-map.sh hard-coded the layout (extents) — measured on one Duo with Android 2022.902.48, slot a. Another
device or another Android version would silently have got wrong ranges. This reader parses the partition table
of the super area itself (Android «liblp» metadata) and prints dmsetup tables. READ ONLY.

Usage: lp-karte.py <super device or image> [slot: a|b]   ->  lines «name sectors start_sector»
"""
import struct
import sys

GEOMETRY_MAGIC = 0x616C4467
HEADER_MAGIC = 0x414C5030
RESERVED = 4096
GEOMETRY_SIZE = 4096


def read_at(f, off, n):
    f.seek(off)
    return f.read(n)


def lp_partitions(f, slot_index):
    geo = read_at(f, RESERVED, 52)
    magic, struct_size = struct.unpack_from("<II", geo, 0)
    if magic != GEOMETRY_MAGIC:
        raise SystemExit("kein super-Bereich (Geometrie fehlt)")
    metadata_max_size, slot_count, block_size = struct.unpack_from("<III", geo, 40)
    if slot_index >= slot_count:
        raise SystemExit(f"Slot {slot_index} gibt es nicht ({slot_count} Slots)")
    base = RESERVED + 2 * GEOMETRY_SIZE + slot_index * metadata_max_size
    hdr = read_at(f, base, 256)
    magic, major, minor, header_size = struct.unpack_from("<IHHI", hdr, 0)
    if magic != HEADER_MAGIC:
        raise SystemExit("Metadaten-Kopf fehlt")
    # header: magic(4) major(2) minor(2) header_size(4) header_checksum(32) tables_size(4) tables_checksum(32)
    #         partitions, extents, groups, block_devices: each {offset u32, num_entries u32, entry_size u32}
    tables_size = struct.unpack_from("<I", hdr, 44)[0]
    desc = struct.unpack_from("<12I", hdr, 80)
    (p_off, p_num, p_size, e_off, e_num, e_size) = desc[:6]
    tables = read_at(f, base + header_size, tables_size)
    extents = []
    for i in range(e_num):
        num_sectors, target_type, target_data, target_source = struct.unpack_from("<QIQI", tables, e_off + i * e_size)
        extents.append((num_sectors, target_type, target_data, target_source))
    parts = {}
    for i in range(p_num):
        raw = tables[p_off + i * p_size: p_off + (i + 1) * p_size]
        name = raw[:36].split(b"\0", 1)[0].decode()
        _attrs, first, count, _group = struct.unpack_from("<IIII", raw, 36)
        parts[name] = [extents[first + k] for k in range(count)]
    return parts


def main():
    dev = sys.argv[1]
    slot = (sys.argv[2] if len(sys.argv) > 2 else "a").lower()
    with open(dev, "rb") as f:
        parts = lp_partitions(f, 0 if slot == "a" else 1)
    for name in ("odm", "product", "system", "system_ext", "vendor"):
        ext = parts.get(f"{name}_{slot}") or parts.get(name)
        if not ext:
            print(f"# {name}_{slot}: nicht vorhanden", file=sys.stderr)
            continue
        # LINEAR only (target_type 0) on the same device; several pieces -> several table rows.
        start = 0
        rows = []
        for num, ttype, data, _src in ext:
            if ttype != 0:
                raise SystemExit(f"{name}: unerwarteter Bereichstyp {ttype}")
            rows.append(f"{start} {num} linear SUPER {data}")
            start += num
        print(f"{name}_{slot}\t" + ";".join(rows))


if __name__ == "__main__":
    main()
