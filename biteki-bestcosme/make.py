# -*- coding: utf-8 -*-
"""美的2027年1月号・美的MEN「下半期ベストコスメ」エントリー表を記入する。

・つるりんちょ。の新製品6アイテムを ライフスタイル／インバスヘアケア に記入
・1ジャンルに複数アイテムのため、62行目の直下に5行を追加（ジャンル名も記入）
"""
from build import (load_parts, save_parts, insert_rows, shift_table,
                   shift_drawing, fill, set_sheets)

SHEET = 'xl/worksheets/sheet1.xml'
GENRE_ROW = 62          # ライフスタイル／インバスヘアケア
CAUTION = ('シャンプー、コンディショナー、トリートメント、頭皮ケアなど\n'
           '香りなど複数展開の場合、イチオシの香りのみエントリーください')

BRAND, KANA = 'つるりんちょ。', 'つるりんちょ'
RELEASE = '2026-07-01'

ITEMS = [
    ('つるりんちょ。シャンプー REGULAR',    '400mL', 5200),
    ('つるりんちょ。トリートメント REGULAR', '380g',  5560),
    ('つるりんちょ。シャンプー REPAIR',     '400mL', 5200),
    ('つるりんちょ。トリートメント REPAIR',  '380g',  5560),
    ('つるりんちょ。トリートメント AIR',     '380g',  5560),
    ('つるりんちょ。シャンプー BOOSTER',    '400mL', 5200),
]

def main(out_path):
    parts = load_parts('work.xlsx')
    order = list(parts.keys())

    extra = len(ITEMS) - 1
    insert_rows(parts, SHEET, after_row=GENRE_ROW, count=extra, template_row=GENRE_ROW + 1,
                cell_values={'A': ('ライフスタイル', 'str'),
                             'B': ('インバスヘアケア', 'str'),
                             'C': (CAUTION, 'str')})
    shift_table(parts, 'xl/tables/table1.xml', extra)
    shift_drawing(parts, 'xl/drawings/drawing1.xml', GENRE_ROW, extra)

    entries = [{'row': GENRE_ROW + i, 'brand': BRAND, 'kana': KANA, 'product': name,
                'oshi': size, 'release': RELEASE, 'price': price}
               for i, (name, size, price) in enumerate(ITEMS)]
    fill(parts, SHEET, entries)

    set_sheets(parts, [(BRAND, 'rId1', 8)])
    save_parts(parts, out_path, order)
    print('wrote', out_path)

if __name__ == '__main__':
    main('【つるりんちょ。】美的2027年1月号・美的MEN「下半期ベストコスメ」リサーチアンケート.xlsx')
