import { interactionStyles, reducedMotionStyles } from './design.js';

export const adminPolishStyles = `
${interactionStyles}
:root{--bg:#0e1019;--panel:#181b29;--panel2:#111420;--line:#303248;--text:#f0edf6;--muted:#a7a4bb;--accent:#efa5bf}
body{background:radial-gradient(ellipse at 95% 0,#976cd914,transparent 45%),radial-gradient(ellipse at 20% 0,#e58aa30b,transparent 35%),var(--bg)}
body>header{height:72px;padding:0 28px;background:#121521f5;z-index:3;gap:16px}.brand{letter-spacing:-.035em;white-space:nowrap}.brand b{color:#f2afc8}.version{display:inline-block;padding:3px 8px;background:#272334;border:1px solid #473448;border-radius:6px;vertical-align:middle}
main{grid-template-columns:224px minmax(0,1fr);min-height:calc(100vh - 72px)}
nav{padding:26px 14px;background:#11141ebf;position:sticky;top:72px;height:calc(100vh - 72px);overflow-y:auto;align-self:start}
.nav-caption{padding:0 14px;margin-bottom:18px;font-size:11px;letter-spacing:.14em;color:var(--muted)}
nav button{position:relative;border:1px solid transparent;padding:11px 13px;border-radius:12px;min-height:44px;white-space:nowrap}
.nav-icon{display:inline-block;vertical-align:-4px;margin-right:12px;width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
nav button.active{background:linear-gradient(100deg,#e58aa324,#a28add0d);border-color:#e58aa32b;color:#ffd1e1;box-shadow:0 3px 12px #00000012}
nav button.active::after{content:'';position:absolute;right:10px;top:calc(50% - 3px);width:6px;height:6px;border-radius:50%;background:var(--accent)}
.content{padding:32px;max-width:1420px;min-width:0;margin:0 auto}h1{font-size:27px;letter-spacing:-.035em}h2{letter-spacing:-.02em}section.active{animation:sakura-enter .32s var(--ease-out)}
.page-eyebrow{font:600 11px/1.5 ui-monospace,monospace;letter-spacing:.15em;color:var(--accent);margin:0 0 12px}.page-description{color:var(--muted);max-width:620px;margin:0;line-height:1.9}
.overview-hero{position:relative;isolation:isolate;overflow:hidden;padding:30px;border:1px solid #e58aa32a;border-radius:20px;background:linear-gradient(120deg,#2d2237,#211f35 55%,#181d2c);margin-bottom:22px}
.overview-hero::after{content:'';position:absolute;z-index:-1;width:200px;height:200px;right:-60px;top:-95px;border:36px solid #e58aa30c;border-radius:50%;pointer-events:none}
.overview-hero h1{margin-bottom:10px}.hero-mark{display:inline-flex;align-items:center;gap:8px;margin-top:20px;color:#c8bbd3;font-size:12px}.hero-mark::before{content:'';width:6px;height:6px;background:#dca4cd;border-radius:50%}
.cards{gap:16px}.card,.box{border-radius:16px;padding:21px;background:linear-gradient(145deg,#1d2030,var(--panel));box-shadow:0 4px 18px #00000012}.card{position:relative;overflow:hidden;animation:sakura-enter .45s var(--ease-out) both}.card:nth-child(2){animation-delay:.04s}.card:nth-child(3){animation-delay:.08s}.card:nth-child(4){animation-delay:.12s}.value{font-size:30px;margin-top:10px;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.card .muted{font-size:12px}
button{min-height:40px;border-radius:10px}button.secondary{background:#2b2d43;border:1px solid #3a3b55}button.danger{background:#472634;border:1px solid #6a3548;color:#ffc8d6}
input,select,textarea{border-radius:10px}textarea{resize:vertical}.toolbar{gap:10px;margin-bottom:20px}.toolbar>*{min-width:0}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.actions{flex-shrink:0}
.item{border-radius:14px;padding:17px;background:#181c2a;align-items:center;transition:border-color .18s ease,background-color .18s ease}.item-main{flex:1}.title{font-size:14px}.item .muted,.tags{line-height:1.8}.item-main,.token,code,.page-description{overflow-wrap:anywhere}
.dialog{padding:20px;background:#080b16c9}.dialog.open{animation:sakura-fade .16s ease}.dialog.open .modal{animation:sakura-dialog .25s var(--ease-out)}.modal{border-radius:20px;padding:26px;box-shadow:0 24px 80px #0007;overscroll-behavior:contain}.modal .field input,.modal .field select{width:100%;min-width:0}
.toast{max-width:min(440px,calc(100vw - 32px));box-shadow:0 12px 35px #0005;border:1px solid #67d6a32b;border-radius:12px;overflow-wrap:anywhere}.toast.show{animation:sakura-enter .22s var(--ease-out)}.toast.bad{border-color:#ff7b8640}
@media(hover:hover) and (pointer:fine){nav button:not(:disabled):hover{transform:translateX(2px);background-color:#ffffff07}.item:hover{border-color:#57506e;background-color:#1c2030}.card:hover{border-color:#60506d}}
@media(max-width:1100px){.item{flex-wrap:wrap}.item>.actions{flex-shrink:1}.content{padding:24px}.brand{font-size:18px}}
@media(max-width:760px){body>header{height:auto;min-height:68px;padding:14px 18px;flex-wrap:wrap}.brand{font-size:17px}header #user{font-size:12px}main{grid-template-columns:minmax(0,1fr)}nav{position:static;height:auto;display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid var(--line);overflow-x:auto;overscroll-behavior-x:contain}.nav-caption{display:none}nav button{width:auto;min-width:0;flex:0 0 auto;margin:0;padding:10px 14px}nav button.active::after{display:none}.nav-icon{margin-right:8px}.content{padding:20px 16px}.overview-hero{padding:24px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:minmax(0,1fr)}.card{padding:16px}.value{font-size:24px}.box{padding:18px}.modal{padding:22px;width:100%;max-height:85svh}.dialog{padding:16px}.item{align-items:flex-start;gap:12px}.item>.actions{width:100%}.toolbar input,.toolbar select{flex:1 1 150px}.toast{right:16px;bottom:16px}h1{font-size:24px}}
#about .cards{grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}#about h1,#about .value{overflow-wrap:anywhere}#about .about-license{font-size:20px}#about .about-links{margin-top:16px}#about a{color:var(--accent);text-underline-offset:3px}
${reducedMotionStyles}
`;
