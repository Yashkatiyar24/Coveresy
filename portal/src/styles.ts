export const CSS = `
:root{
  /* Palette lifted from the public site (assets/*.css + index.html) so the
     portal reads as the same product: purple hero, orange CTA, yellow accent. */
  --brand:#3c286e;          /* --pos-bg-color: 60 40 110, the hero background */
  --brand-dark:#2e1e55;
  --brand-light:#4c3485;
  --accent:#f47521;         /* the site's CTA orange */
  --accent-dark:#e0651a;
  --gold:#f7ca15;           /* the yellow in the Coveresy logo */
  --ink:#2b404a;            /* --pos-text-color: 43 64 74 */
  --ink-strong:#2b2f38;
  --muted:#6b7280;
  --muted-soft:#9aa0a6;
  --line:#d9dde3;
  --bg:#f6f7f9;
  --card:#fff;
  --good:#1f7a3d; --good-bg:#eaf7ee;
  --bad:#e03b3b;  --bad-bg:#fdecec;
  --warn:#9a6400; --warn-bg:#fdf3dd;
  --neutral-bg:#eef0f4;
  --radius:6px;             /* the site uses 6px on inputs and buttons */
  --shadow:0 1px 2px rgba(43,64,74,.06),0 4px 16px rgba(43,64,74,.05);
}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 Lato,"Helvetica Neue",Helvetica,Tahoma,Arial,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--brand);text-decoration:none}
a:hover{color:var(--accent)}
a:hover{text-decoration:underline}
main{max-width:1120px;margin:0 auto;padding:24px 16px 64px}
main.wide{max-width:1560px}
body.out{background:var(--brand)}
body.out main{max-width:460px;padding-top:7vh}
.loginmark{text-align:center;margin-bottom:22px}
.loginmark img{width:190px}

/* header */
.top{display:flex;align-items:center;gap:16px;background:var(--brand);color:#fff;padding:0 16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;padding:11px 0;color:#fff}
.brand:hover{text-decoration:none}
.brand img{width:132px;display:block}
.brand span{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);border-left:1px solid rgba(255,255,255,.3);padding-left:9px}
.top nav{display:flex;gap:2px;flex:1;flex-wrap:wrap}
.top nav a{color:#d6cfe8;padding:14px 11px;font-size:14px;border-bottom:3px solid transparent}
.top nav a:hover{color:#fff;text-decoration:none}
.top nav a.on{color:#fff;border-bottom-color:var(--gold)}
.who{display:flex;align-items:center;gap:8px;font-size:13px;color:#d6cfe8}
.who em{font-style:normal;background:rgba(255,255,255,.15);padding:2px 7px;border-radius:99px}
.who form{margin:0}
.navtoggle{display:none;background:none;border:0;color:#fff;font-size:22px;cursor:pointer}

/* cards + headings */
h1{font-size:23px;margin:0 0 4px;color:var(--ink-strong);font-weight:700}
h2{font-size:17px;margin:0 0 12px;color:var(--ink-strong);font-weight:700}
h3{font-size:14px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow);margin-bottom:20px}
.card.narrow{max-width:460px;margin-inline:auto}
.pagehead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.pagehead p{margin:2px 0 0;color:var(--muted);font-size:14px}
.sub{color:var(--muted);font-size:14px;margin:0 0 16px}
.grid{display:grid;gap:16px}
.grid.c2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.grid.c3{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.grid.c4{grid-template-columns:repeat(auto-fit,minmax(175px,1fr))}

/* stats */
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow)}
.stat b{display:block;font-size:26px;color:var(--brand);line-height:1.15;font-variant-numeric:tabular-nums}
.stat span{display:block;font-size:12.5px;color:var(--muted);margin-top:3px}
.stat.alert b{color:var(--bad)}
.stat{border-top:3px solid var(--brand)}
.stat.alert{border-top-color:var(--bad)}

/* tables */
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:#faf9fc;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:#faf8fd}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
a.sort{color:var(--muted)}
.pager{display:flex;align-items:center;gap:12px;margin-top:12px;font-size:13px}
.pg{padding:5px 11px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
.pg.off{color:#aab7c6;border-color:#eef2f7}
.pagecount{color:var(--muted);font-size:13px;margin:0}
.empty{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:var(--radius);padding:28px;text-align:center;margin:0}

/* badges */
.badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.good{background:var(--good-bg);color:var(--good)}
.badge.bad{background:var(--bad-bg);color:var(--bad)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.badge.neutral{background:var(--neutral-bg);color:var(--muted)}
.tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:4px}
.tag.mand{background:var(--bad-bg);color:var(--bad)}
.tag.opt{background:var(--neutral-bg);color:var(--muted)}

/* forms */
label{display:block;font-size:13px;font-weight:600;margin-bottom:5px}
label .req{color:var(--bad)}
input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius);font:inherit;background:#fff;color:var(--ink-strong)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(244,117,33,.15)}
input[type=file]{padding:8px}
input[type=radio],input[type=checkbox]{accent-color:var(--accent);width:auto}
.field{margin-bottom:14px}
.field small{display:block;color:var(--muted);font-size:12px;margin-top:4px}
.row{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
fieldset{border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin:0 0 18px}
legend{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;padding:0 6px}
button,.btn{display:inline-block;padding:9px 16px;border:1px solid var(--accent);border-radius:var(--radius);background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer}
button:hover,.btn:hover{background:var(--accent-dark);border-color:var(--accent-dark);text-decoration:none;color:#fff}
.btn.ghost,button.ghost{background:#fff;color:var(--brand);border-color:var(--line)}
.btn.ghost:hover,button.ghost:hover{background:#f3f0f9;color:var(--brand);border-color:var(--brand-light)}
.btn.danger,button.danger{background:var(--bad);border-color:var(--bad)}
.btn.danger:hover,button.danger:hover{background:#8e1b22}
.btn.sm,button.sm{padding:5px 11px;font-size:13px}
button.link{background:none;border:0;color:#d6cfe8;text-decoration:underline;padding:0;font-weight:400;cursor:pointer}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px}
form.inline{display:inline}

/* flash */
.flash{padding:11px 14px;border-radius:8px;margin-bottom:18px;font-size:14px;border:1px solid}
.flash.ok{background:var(--good-bg);border-color:#b6e2c9;color:var(--good)}
.flash.err{background:var(--bad-bg);border-color:#f2c3c6;color:var(--bad)}

/* filters */
.filters{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px;margin-bottom:16px}
.filters .row{grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px}
.filters label{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.filters input,.filters select{padding:7px 9px;font-size:13.5px}

/* documents */
.doc{display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.doc:last-child{border-bottom:0}
.doc .meta{flex:1;min-width:230px}
.doc .meta b{display:block;margin-bottom:4px}
.doc .meta small{display:block;color:var(--muted);font-size:12.5px;margin-top:3px}
.doc .act{display:flex;gap:7px;flex-wrap:wrap;align-items:flex-start}
.progress{height:7px;background:var(--neutral-bg);border-radius:99px;overflow:hidden;margin:8px 0 4px}
.progress i{display:block;height:100%;background:var(--good);transition:width .2s}
.missinglist{color:var(--bad);font-size:13.5px;margin:6px 0 0}

/* detail layout */
.split{display:grid;gap:20px;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);align-items:start}
dl.kv{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;margin:0;font-size:14px}
dl.kv dt{color:var(--muted)}
dl.kv dd{margin:0;font-weight:500;word-break:break-word}
.timeline{list-style:none;margin:0;padding:0;font-size:13.5px}
.timeline li{padding:9px 0;border-bottom:1px solid var(--line)}
.timeline li:last-child{border-bottom:0}
.timeline small{color:var(--muted);display:block;margin-top:2px}
code{background:var(--neutral-bg);padding:1px 6px;border-radius:4px;font-size:13px}
pre{background:var(--brand-dark);color:#d7e4f2;padding:14px;border-radius:8px;overflow:auto;font-size:12.5px}

@media(max-width:860px){
  .navtoggle{display:block;order:2;margin-left:auto}
  .top nav{display:none;flex-basis:100%;flex-direction:column;order:4}
  body.navopen .top nav{display:flex}
  .top nav a{padding:10px 0}
  .who{order:3;flex-basis:100%;padding-bottom:10px}
  .split{grid-template-columns:1fr}
  th,td{padding:8px 10px}
}
@media print{.top,.actions,.filters,.pager{display:none}body{background:#fff}}
`;
