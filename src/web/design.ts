/** Static, dependency-free presentation shared by the server-rendered pages. */
export const interactionStyles = `
:root{--ease-out:cubic-bezier(.22,1,.36,1)}
body{font-family:system-ui,'Microsoft YaHei',sans-serif}
button{font-family:inherit}
[hidden]{display:none!important}
button,a,input,select,textarea{-webkit-tap-highlight-color:transparent}
button,.btn{transition:transform .18s var(--ease-out),background-color .18s ease,border-color .18s ease,box-shadow .18s ease,color .18s ease}
button:disabled{cursor:wait}
input,select,textarea{transition:border-color .18s ease,box-shadow .18s ease;max-width:100%;font:inherit}
input[type=checkbox]{accent-color:var(--accent)}
:where(button,a,input,select,textarea):focus-visible{outline:2px solid var(--accent);outline-offset:4px}
:where(input,select,textarea):focus{border-color:var(--accent);box-shadow:0 0 0 3px #e58aa31c}
@media(hover:hover) and (pointer:fine){button:not(:disabled):hover,.btn:hover{transform:translateY(-2px)}button:not(:disabled):active,.btn:active{transform:translateY(0)}}
@keyframes sakura-enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes sakura-dialog{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes sakura-fade{from{opacity:0}to{opacity:1}}
@keyframes sakura-spin{to{transform:rotate(360deg)}}
`;

/** Keep last in each stylesheet: overrides motion, including existing page rules. */
export const reducedMotionStyles = `
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

export const loginPolishStyles = `
${interactionStyles}
:root{--muted:#70636b;--brand-a:#ae466c;--brand-m:#80438e;--brand-b:#54349b}
[data-theme=dark]{--muted:#afa5b5}
body{min-height:100svh;background:radial-gradient(ellipse at 95% 5%,#e58aa317,transparent 48%),var(--bg)}
.brand-panel{isolation:isolate;background:radial-gradient(ellipse at 10% 5%,#ffffff22,transparent 50%),linear-gradient(150deg,var(--brand-a),var(--brand-m) 55%,var(--brand-b))}
.brand-panel::before,.brand-panel::after{content:'';position:absolute;z-index:-1;pointer-events:none;border:1px solid #ffffff26;border-radius:50%;width:440px;height:440px;right:-210px;top:-160px}
.brand-panel::after{width:320px;height:320px;right:-150px;top:-100px;background:#ffffff05}
.brand-body{position:relative;z-index:1;animation:sakura-enter .7s var(--ease-out) both}
.brand-chip{border:1px solid #ffffff33;box-shadow:0 12px 35px #30144024;transform:rotate(-6deg)}
.brand-chip svg{transform:rotate(6deg)}
.brand-name{font-size:clamp(2rem,3.4vw,3.25rem);letter-spacing:-.04em;max-width:520px}
.brand-name,.compact-name{min-width:0;overflow-wrap:anywhere}
.compact-brand{min-width:0}.compact-chip{flex-shrink:0}
.brand-slogan{font-size:16px;line-height:1.8;max-width:390px}
.brand-features{gap:24px}.brand-features li{animation:sakura-enter .65s var(--ease-out) both}
.brand-features li:nth-child(1){animation-delay:.1s}.brand-features li:nth-child(2){animation-delay:.18s}.brand-features li:nth-child(3){animation-delay:.26s}
.feat-icon{border:1px solid #ffffff24}.feat-desc{color:#ffffffce}.brand-foot{color:#ffffffb8}
.brand-deco{width:320px;height:320px;bottom:-90px;right:-65px;transform:rotate(-15deg)}
.form-col{max-width:460px;animation:sakura-enter .65s .08s var(--ease-out) both}
.side main{position:relative;border-radius:24px;box-shadow:var(--shadow),0 1px 0 #ffffff12 inset;padding:36px 32px;text-align:left}
.side main::before{content:'';position:absolute;top:-1px;left:32px;right:32px;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);pointer-events:none}
.side h1{font-size:28px;letter-spacing:-.035em;line-height:1.35;margin-bottom:12px}
.sub{line-height:1.8}.side input{border-radius:12px;padding:12px 14px}
.side .btn,#submitButton{border-radius:12px;min-height:46px}
#submitButton{background:linear-gradient(115deg,#ec9db3,#cb9de4);color:#281a31;box-shadow:0 5px 18px #ba648826}
#submitButton:disabled{opacity:.75;display:flex;align-items:center;justify-content:center;gap:10px}
#submitButton:disabled::before{content:'';width:15px;height:15px;flex:none;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sakura-spin .8s linear infinite}
.themes{padding:4px;background:var(--bg);border:1px solid var(--line);border-radius:12px;gap:4px}.themes button{flex:1;border-color:transparent;min-height:36px;margin:0;border-radius:8px;padding:6px}
.foot{text-align:center}#notice{animation:sakura-enter .25s var(--ease-out) both}
@media(max-width:899px){body{background:radial-gradient(ellipse at 50% 0,#e58aa31f,transparent 65%),var(--bg)}.side{padding:32px 20px}.compact-brand{justify-content:center;margin-bottom:26px}.side main{padding:28px 24px}.side h1{font-size:25px}}
@media(max-width:380px){.side{padding:24px 12px}.side main{padding:24px 18px}}
${reducedMotionStyles}
`;
