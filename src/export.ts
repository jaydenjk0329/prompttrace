import { summarize } from "./attribution.js";
import { TraceDB } from "./db.js";
import { importNotes } from "./notes.js";
import { redact } from "./redact.js";

/** Self-contained HTML timeline of prompts → diffs, filterable by author/agent/file/text. */
export function exportHtml(db: TraceDB, opts: { limit?: number; repoName?: string } = {}): string {
  importNotes(db);
  const turns = db.listTurns({ limit: opts.limit ?? 2000 }).map((t) => ({
    ...summarize(db, t),
    // Shareable export: always the redacted prompt, even for your own turns.
    prompt: t.prompt_redacted,
    files: db.filesForTurn(t.id),
    diff: redact(t.diff ?? ""),
  }));
  const data = JSON.stringify(turns).replace(/</g, "\\u003c");
  const title = `prompttrace — ${opts.repoName ?? "repo"}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#e5e5ea;--card:#fafafa;--add:#e6f4ea;--del:#fdecea;--hunk:#eef2ff;--acc:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf1;--mut:#9a9aa3;--line:#2c2c31;--card:#1b1b1f;--add:#15301f;--del:#3a1a1a;--hunk:#1d2240;--acc:#91a7ff}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;z-index:1}
h1{font-size:16px;margin:0 12px 0 0}input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
#q{flex:1;min-width:200px}main{max-width:1000px;margin:0 auto;padding:16px 20px}
.turn{border:1px solid var(--line);border-radius:10px;background:var(--card);margin:0 0 12px;overflow:hidden}
.meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--mut);font-size:12px;padding:10px 14px 0}.meta b{color:var(--fg);font-weight:600}
.tag{border:1px solid var(--line);border-radius:999px;padding:0 8px}
.prompt{padding:8px 14px 12px;white-space:pre-wrap;word-break:break-word;font-size:14px}
.files{padding:0 14px 10px;font-size:12px;color:var(--mut)}.files code{color:var(--acc)}
details summary{cursor:pointer;padding:8px 14px;border-top:1px solid var(--line);color:var(--mut);font-size:12px}
pre{margin:0;padding:8px 0;overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;border-top:1px solid var(--line)}
pre span{display:block;padding:0 14px;white-space:pre}.a{background:var(--add)}.d{background:var(--del)}.h{background:var(--hunk);color:var(--mut)}.f{font-weight:600}
#count{color:var(--mut);font-size:12px}
</style></head><body>
<header><h1>${esc(title)}</h1>
<input id="q" placeholder="Search prompts and files…">
<select id="author"><option value="">All people</option></select>
<select id="agent"><option value="">All agents</option></select>
<span id="count"></span></header>
<main id="list"></main>
<script>
const TURNS=${data};
const $=s=>document.querySelector(s),esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
for(const [id,key] of [["#author","author"],["#agent","agent"]]){for(const v of [...new Set(TURNS.map(t=>t[key]))].sort()){const o=document.createElement("option");o.value=o.textContent=v;$(id).append(o)}}
function diffHtml(d){return d.split("\\n").map(l=>{const c=l.startsWith("diff --git")||l.startsWith("+++")||l.startsWith("---")?"f":l.startsWith("@@")?"h":l.startsWith("+")?"a":l.startsWith("-")?"d":"";return '<span class="'+c+'">'+esc(l)+"</span>"}).join("")}
function render(){const q=$("#q").value.toLowerCase(),a=$("#author").value,g=$("#agent").value;
const rows=TURNS.filter(t=>(!a||t.author===a)&&(!g||t.agent===g)&&(!q||t.prompt.toLowerCase().includes(q)||t.files.some(f=>f.toLowerCase().includes(q))));
$("#count").textContent=rows.length+" of "+TURNS.length+" prompts";
$("#list").innerHTML=rows.map(t=>'<article class="turn"><div class="meta"><b>'+esc(t.author)+'</b><span class="tag">'+esc(t.agent)+'</span><span>'+new Date(t.started_at).toLocaleString()+'</span><span title="'+esc(t.id)+'">#'+esc(t.id.slice(0,8))+'</span>'+(t.commits.length?'<span>commit '+t.commits.map(c=>esc(c.slice(0,8))).join(", ")+'</span>':'<span>uncommitted</span>')+'</div><div class="prompt">'+esc(t.prompt)+'</div>'+(t.files.length?'<div class="files">'+t.files.map(f=>"<code>"+esc(f)+"</code>").join(" · ")+'</div>':'')+(t.diff?'<details><summary>Show diff</summary><pre>'+diffHtml(t.diff)+'</pre></details>':'')+'</article>').join("")||'<p style="color:var(--mut)">No prompts match.</p>'}
for(const id of ["#q","#author","#agent"])$(id).addEventListener("input",render);render();
</script></body></html>
`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
