# -*- coding: utf-8 -*-
"""美的2027年1月号・美的MEN「下半期ベストコスメ」エントリー表を記入する。

・ライフスタイル／インバスヘアケア  … つるりんちょ。6アイテム（62〜67行目）
・ライフスタイル／アウトバスヘアケア … いるかのせなか。4アイテム（68〜71行目）
1ジャンルに複数アイテムのため行を追加し、追加行にもジャンル名を記入する。
"""
from build import (load_parts, save_parts, insert_rows, shift_table,
                   shift_drawing, fill, set_sheets, add_pictures, set_row_height)

SHEET, TABLE, DRAWING = ('xl/worksheets/sheet1.xml', 'xl/tables/table1.xml',
                         'xl/drawings/drawing1.xml')
BRAND, KANA = '髪にドラマを', 'かみにどらまを'

INBATH_ROW, OUTBATH_ROW = 62, 63          # 元ファイルでの行番号
INBATH_NOTE = ('シャンプー、コンディショナー、トリートメント、頭皮ケアなど\n'
               '香りなど複数展開の場合、イチオシの香りのみエントリーください')
OUTBATH_NOTE = ('オイル、ミルク、スタイリング剤など\n'
                '香りなど複数展開の場合、イチオシの香りのみエントリーください')

# 商品名, イチオシ（サイズ）, 税込価格, 発売日, 商品写真（キリヌキ png / なし）
INBATH = [
    ('つるりんちょ。シャンプー REGULAR',    '400mL', 5200, '2026-07-01', 'img/1.png'),
    ('つるりんちょ。トリートメント REGULAR', '380g',  5560, '2026-07-01', 'img/4.png'),
    ('つるりんちょ。シャンプー REPAIR',     '400mL', 5200, '2026-07-01', 'img/3.png'),
    ('つるりんちょ。トリートメント REPAIR',  '380g',  5560, '2026-07-01', 'img/6.png'),
    ('つるりんちょ。トリートメント AIR',     '380g',  5560, '2026-07-01', 'img/5.png'),
    ('つるりんちょ。シャンプー BOOSTER',    '400mL', 5200, '2026-07-01', 'img/2.png'),
]
OUTBATH = [
    ('いるかのせなか。オイル',    '80mL',  4350, '2026-08-15', None),
    ('いるかのせなか。CMCミルク', '140g',  4720, '2026-08-15', None),
    ('いるかのせなか。フォーム',  '180mL', 4350, '2026-08-15', None),
    ('いるかのせなか。ミスト',    '150mL', 4200, '2026-08-15', None),
]

H_COL_WIDTH = 27.69921875        # 元ファイルの H 列幅
PHOTO_ROW_HEIGHT = 105           # 写真を置く行だけ高くして画像を見やすくする

def entries_for(first_row, items):
    return [{'row': first_row + i, 'brand': BRAND, 'kana': KANA, 'product': name,
             'oshi': size, 'release': release, 'price': price,
             'photo': None if photo else 'なし'}
            for i, (name, size, price, release, photo) in enumerate(items)]

def main(out_path):
    parts = load_parts('work.xlsx')
    order = list(parts.keys())

    # 下の行から追加していく（先に追加すると上の行番号が変わらない）
    for after, count, genre, note, template in (
            (OUTBATH_ROW, len(OUTBATH) - 1, 'アウトバスヘアケア', OUTBATH_NOTE, OUTBATH_ROW + 1),
            (INBATH_ROW,  len(INBATH) - 1,  'インバスヘアケア',   INBATH_NOTE,  INBATH_ROW + 1)):
        insert_rows(parts, SHEET, after_row=after, count=count, template_row=template,
                    cell_values={'A': ('ライフスタイル', 'str'), 'B': (genre, 'str'),
                                 'C': (note, 'str')})
        shift_table(parts, TABLE, count)
        shift_drawing(parts, DRAWING, after, count)

    inbath_first = INBATH_ROW
    outbath_first = OUTBATH_ROW + len(INBATH) - 1   # インバスの追加行のぶんだけ下がる
    fill(parts, SHEET, entries_for(inbath_first, INBATH) + entries_for(outbath_first, OUTBATH))

    photo_rows = [inbath_first + i for i in range(len(INBATH))]
    set_row_height(parts, SHEET, photo_rows, PHOTO_ROW_HEIGHT)
    add_pictures(parts, order, DRAWING,
                 [(7, row, photo, name)                              # 7 = H 列
                  for row, (name, _, _, _, photo) in zip(photo_rows, INBATH)],
                 H_COL_WIDTH, PHOTO_ROW_HEIGHT)

    set_sheets(parts, [(BRAND, 'rId1', 8)])
    save_parts(parts, out_path, order)
    print('wrote', out_path)

if __name__ == '__main__':
    main('【髪にドラマを】美的2027年1月号・美的MEN「下半期ベストコスメ」リサーチアンケート.xlsx')
