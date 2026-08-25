# -*- coding: utf-8 -*-
"""美的 下半期ベストコスメ エントリー表を、元ファイルの書式・セル内画像・テーブル定義を
壊さずに XML レベルで編集するスクリプト。
  1) シートをブランドごとに複製・リネーム
  2) 赤枠内 (D:K) の該当ジャンル行に記入
"""
import json, re, shutil, zipfile, datetime, os, sys, html

SRC = 'work.xlsx'
WORKDIR = 'build'

def load_parts(src):
    parts = {}
    with zipfile.ZipFile(src) as z:
        for n in z.namelist():
            parts[n] = z.read(n)
    return parts

def save_parts(parts, dst, order):
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
        for n in order:
            z.writestr(n, parts[n])

def dup_sheet(parts, order, idx):
    """sheet1 を複製して sheet{idx} / drawing{idx} / table{idx} を作る。"""
    t = lambda b: b.decode('utf-8')
    e = lambda s: s.encode('utf-8')

    parts['xl/worksheets/sheet%d.xml' % idx] = parts['xl/worksheets/sheet1.xml']
    parts['xl/worksheets/_rels/sheet%d.xml.rels' % idx] = e(
        t(parts['xl/worksheets/_rels/sheet1.xml.rels'])
        .replace('../drawings/drawing1.xml', '../drawings/drawing%d.xml' % idx)
        .replace('../tables/table1.xml', '../tables/table%d.xml' % idx))
    parts['xl/drawings/drawing%d.xml' % idx] = parts['xl/drawings/drawing1.xml']

    # テーブルは id / name / displayName / uid をユニークにする必要がある
    tbl = t(parts['xl/tables/table1.xml'])
    tbl = tbl.replace(' id="3" ', ' id="%d" ' % (100 + idx))
    tbl = tbl.replace('name="テーブル134" displayName="テーブル134"',
                      'name="テーブル1%d" displayName="テーブル1%d"' % (34 + idx, 34 + idx))
    tbl = re.sub(r'xr:uid="\{[^}]+\}"', 'xr:uid="{980E943F-20C8-4FBA-BA1A-24E8775330%02d}" ' % idx, tbl, count=1)
    parts['xl/tables/table%d.xml' % idx] = e(tbl)

    for n in ('xl/worksheets/sheet%d.xml' % idx, 'xl/drawings/drawing%d.xml' % idx,
              'xl/tables/table%d.xml' % idx, 'xl/worksheets/_rels/sheet%d.xml.rels' % idx):
        if n not in order:
            order.append(n)

    ct = t(parts['[Content_Types].xml'])
    for pn, cty in (('/xl/worksheets/sheet%d.xml' % idx,
                     'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'),
                    ('/xl/drawings/drawing%d.xml' % idx,
                     'application/vnd.openxmlformats-officedocument.drawing+xml'),
                    ('/xl/tables/table%d.xml' % idx,
                     'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml')):
        ct = ct.replace('</Types>', '<Override PartName="%s" ContentType="%s"/></Types>' % (pn, cty))
    parts['[Content_Types].xml'] = e(ct)

    rels = t(parts['xl/_rels/workbook.xml.rels'])
    rid = 'rIdSheet%d' % idx
    rels = rels.replace('</Relationships>',
        '<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        'relationships/worksheet" Target="worksheets/sheet%d.xml"/></Relationships>' % (rid, idx))
    parts['xl/_rels/workbook.xml.rels'] = e(rels)
    return rid

def set_sheets(parts, sheets):
    """sheets = [(name, rId, sheetId), ...] の順で <sheets> を書き換える。"""
    wb = parts['xl/workbook.xml'].decode('utf-8')
    xml = '<sheets>' + ''.join(
        '<sheet name="%s" sheetId="%d" r:id="%s"/>' % (html.escape(n, quote=True), sid, rid)
        for n, rid, sid in sheets) + '</sheets>'
    wb = re.sub(r'<sheets>.*?</sheets>', xml, wb, flags=re.S)
    parts['xl/workbook.xml'] = wb.encode('utf-8')

SERIAL_EPOCH = datetime.date(1899, 12, 30)

def put(sheet_xml, ref, value, kind):
    """空セル <c r="D62" s="50"/> に値を入れる。書式(s)はそのまま維持。"""
    m = re.search(r'<c r="%s"(?: s="(\d+)")?\s*/>' % ref, sheet_xml)
    if not m:
        raise SystemExit('cell not found or not empty: %s' % ref)
    s = ' s="%s"' % m.group(1) if m.group(1) else ''
    if kind == 'str':
        new = '<c r="%s"%s t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (
            ref, s, html.escape(str(value)))
    elif kind == 'num':
        new = '<c r="%s"%s><v>%s</v></c>' % (ref, s, value)
    elif kind == 'date':
        d = datetime.date(*map(int, value.split('-')))
        new = '<c r="%s"%s><v>%d</v></c>' % (ref, s, (d - SERIAL_EPOCH).days)
    else:
        raise SystemExit('bad kind %s' % kind)
    return sheet_xml[:m.start()] + new + sheet_xml[m.end():]

COLS = [('D', 'brand', 'str'), ('E', 'kana', 'str'), ('F', 'product', 'str'),
        ('G', 'oshi', 'str'), ('H', 'photo', 'str'), ('I', 'release', 'date'),
        ('J', 'price', 'num'), ('K', 'editorial', 'str')]

def fill(parts, part_name, entries):
    xml = parts[part_name].decode('utf-8')
    for ent in entries:
        row = ent['row']
        for col, key, kind in COLS:
            if ent.get(key) in (None, ''):
                continue
            xml = put(xml, '%s%d' % (col, row), ent[key], kind)
    parts[part_name] = xml.encode('utf-8')

def main(spec_path, out_path):
    spec = json.load(open(spec_path, encoding='utf-8'))
    parts = load_parts(SRC)
    order = list(parts.keys())

    # 先に全シートを複製してから記入する（複製元が汚れないように）
    sheets, targets = [], []
    for i, sh in enumerate(spec['sheets']):
        if i == 0:
            part, rid, sid = 'xl/worksheets/sheet1.xml', 'rId1', 8
        else:
            idx = i + 1
            rid = dup_sheet(parts, order, idx)
            part, sid = 'xl/worksheets/sheet%d.xml' % idx, 8 + idx
        sheets.append((sh['name'], rid, sid))
        targets.append((part, sh['entries']))

    for part, entries in targets:
        fill(parts, part, entries)

    set_sheets(parts, sheets)
    save_parts(parts, out_path, order)
    print('wrote', out_path)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])


# ---- 行の追加（1ジャンルに複数アイテムを入れる場合） ----------------------

ROW_RE = re.compile(r'<row r="(\d+)"([^>]*?)(/>|>(.*?)</row>)', re.S)

def _renumber(row_xml, old, new):
    row_xml = re.sub(r'(<row r=")%d(")' % old, r'\g<1>%d\g<2>' % new, row_xml, count=1)
    return re.sub(r'(<c r="([A-Z]+))%d(")' % old, r'\g<1>%d\g<3>' % new, row_xml)

def insert_rows(parts, part_name, after_row, count, template_row, cell_values):
    """after_row の直下に count 行を追加する。書式は template_row から複製。
    テーブル参照・dimension・図形アンカーもあわせてずらす。"""
    xml = parts[part_name].decode('utf-8')
    head, body, tail = xml.partition('<sheetData>')
    body, _, tail = tail.partition('</sheetData>')

    rows = {int(m.group(1)): m.group(0) for m in ROW_RE.finditer(body)}
    template = rows[template_row]

    out = {}
    for r, x in rows.items():
        out[r + count if r > after_row else r] = _renumber(x, r, r + count) if r > after_row else x

    for i in range(1, count + 1):
        new_r = after_row + i
        row = _renumber(template, template_row, new_r)
        for col, (value, kind) in cell_values.items():
            ref = '%s%d' % (col, new_r)
            # テンプレート側に値が残っていれば一度空セルに戻してから入れ直す
            # ([^/>]* により自己終了タグ <c .../> には誤マッチしない)
            row = re.sub(r'<c r="%s"( s="\d+")?[^/>]*>.*?</c>' % ref,
                         lambda m: '<c r="%s"%s/>' % (ref, m.group(1) or ''), row, flags=re.S)
            row = put(row, ref, value, kind)
        out[new_r] = row

    body = ''.join(out[r] for r in sorted(out))
    xml = head + '<sheetData>' + body + '</sheetData>' + tail

    last = max(out)
    xml = re.sub(r'<dimension ref="A1:K\d+"/>', '<dimension ref="A1:K%d"/>' % last, xml)
    parts[part_name] = xml.encode('utf-8')
    return count

def shift_table(parts, table_name, count):
    t = parts[table_name].decode('utf-8')
    t = re.sub(r'ref="A19:K(\d+)"', lambda m: 'ref="A19:K%d"' % (int(m.group(1)) + count), t)
    parts[table_name] = t.encode('utf-8')

def shift_drawing(parts, drawing_name, after_row, count):
    d = parts[drawing_name].decode('utf-8')
    # xdr:row は 0 始まり。after_row(1 始まり) より下の図形をずらす
    d = re.sub(r'<xdr:row>(\d+)</xdr:row>',
               lambda m: '<xdr:row>%d</xdr:row>' % (int(m.group(1)) + count
                                                   if int(m.group(1)) >= after_row else int(m.group(1))), d)
    parts[drawing_name] = d.encode('utf-8')


# ---- セル内画像（「セルに配置」= richValue 形式）の埋め込み -----------------

def embed_cell_images(parts, order, sheet_part, mapping):
    """mapping = {'H62': 'img/1.png', ...} をセル内画像として埋め込む。

    Excel の「セルに配置」画像は richData として保持される：
      cell(vm) -> metadata.valueMetadata -> metadata.futureMetadata
               -> rdrichvalue.rv -> richValueRel.rel -> rels -> xl/media/*
    既存の記入例画像（vm=1,2）を壊さないよう、すべて末尾に追記する。
    """
    t = lambda n: parts[n].decode('utf-8')
    e = lambda n, s: parts.__setitem__(n, s.encode('utf-8'))

    rels, rvrel = t('xl/richData/_rels/richValueRel.xml.rels'), t('xl/richData/richValueRel.xml')
    rv, meta = t('xl/richData/rdrichvalue.xml'), t('xl/metadata.xml')
    sheet = t(sheet_part)

    media_no = 1 + max(int(m) for m in re.findall(r'xl/media/image(\d+)\.', '\n'.join(parts)))
    rel_no = 1 + max(int(m) for m in re.findall(r'Id="rId(\d+)"', rels))
    n_rv = int(re.search(r'<rvData[^>]*count="(\d+)"', rv).group(1))
    n_vm = int(re.search(r'<valueMetadata count="(\d+)"', meta).group(1))

    for ref, path in mapping.items():
        name = 'xl/media/image%d.png' % media_no
        parts[name] = open(path, 'rb').read()
        order.append(name)

        rels = rels.replace('</Relationships>',
            '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/'
            '2006/relationships/image" Target="../media/image%d.png"/></Relationships>'
            % (rel_no, media_no))
        rvrel = rvrel.replace('</richValueRels>', '<rel r:id="rId%d"/></richValueRels>' % rel_no)
        rv = rv.replace('</rvData>', '<rv s="0"><v>%d</v><v>5</v></rv></rvData>' % n_rv)
        meta = meta.replace('</futureMetadata>',
            '<bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}">'
            '<xlrd:rvb i="%d"/></ext></extLst></bk></futureMetadata>' % n_rv)
        meta = meta.replace('</valueMetadata>', '<bk><rc t="1" v="%d"/></bk></valueMetadata>' % n_vm)

        m = re.search(r'<c r="%s"(?: s="(\d+)")?\s*/>' % ref, sheet)
        if not m:
            raise SystemExit('cell not found or not empty: %s' % ref)
        sheet = (sheet[:m.start()]
                 + '<c r="%s"%s t="e" vm="%d"><v>#VALUE!</v></c>'
                   % (ref, ' s="%s"' % m.group(1) if m.group(1) else '', n_vm + 1)
                 + sheet[m.end():])

        media_no, rel_no, n_rv, n_vm = media_no + 1, rel_no + 1, n_rv + 1, n_vm + 1

    rv = re.sub(r'(<rvData[^>]*count=")\d+(")', r'\g<1>%d\g<2>' % n_rv, rv)
    meta = re.sub(r'(<futureMetadata name="XLRICHVALUE" count=")\d+(")', r'\g<1>%d\g<2>' % n_rv, meta)
    meta = re.sub(r'(<valueMetadata count=")\d+(")', r'\g<1>%d\g<2>' % n_vm, meta)

    e('xl/richData/_rels/richValueRel.xml.rels', rels)
    e('xl/richData/richValueRel.xml', rvrel)
    e('xl/richData/rdrichvalue.xml', rv)
    e('xl/metadata.xml', meta)
    e(sheet_part, sheet)
