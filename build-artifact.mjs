// index.html（単体で開けるHTML）から、Artifact 公開用の dist/artifact.html を作る。
// Artifact は <!doctype>/<html>/<head>/<body> を公開時に付けるので、その外側だけを外す。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const src = readFileSync("index.html", "utf8");
const cut = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`マーカーが見つかりません: ${a < 0 ? from : to}`);
  return src.slice(a + from.length, b);
};

const head = cut("<!-- ARTIFACT:BEGIN -->", "<!-- ARTIFACT:HEAD-END -->");
const body = cut("<!-- ARTIFACT:HEAD-END -->", "<!-- ARTIFACT:END -->")
  .replace(/^\s*<\/head>\s*/, "\n")
  .replace(/^\s*<body>\s*/, "");

const out = (head.trim() + "\n\n" + body.trim() + "\n");
for (const tag of ["<!DOCTYPE", "<html", "</html>", "<head>", "</head>", "<body>", "</body>"]) {
  if (out.includes(tag)) throw new Error(`外側のタグが残っています: ${tag}`);
}
if (!/^<title>.+<\/title>/m.test(out)) throw new Error("<title> が先頭にありません");

mkdirSync("dist", { recursive: true });
writeFileSync("dist/artifact.html", out);
console.log(`dist/artifact.html を書き出しました (${out.length} bytes)`);
