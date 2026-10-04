import { interactionStyles, reducedMotionStyles } from '../web/design.js';

export const setupPolishStyles = `
${interactionStyles}
body{min-height:100svh;background:radial-gradient(ellipse at 10% 0,#e58aa315,transparent 45%),radial-gradient(ellipse at 100% 30%,#9078df12,transparent 50%),var(--bg)}
main{max-width:960px}header{animation:sakura-enter .5s var(--ease-out)}h1{letter-spacing:-.04em;font-size:clamp(26px,4vw,36px)}
.steps{gap:10px;margin:30px 0}.step{height:6px;transition:background-color .2s ease}.step.active{background:linear-gradient(90deg,#e58aa3,#c0a0e5);box-shadow:0 2px 10px #e58aa31a}
section{border-radius:22px;background:linear-gradient(145deg,#1d2030,#151b26);box-shadow:0 16px 50px #0003}section.active{animation:sakura-enter .32s var(--ease-out)}
button{border-radius:11px;min-height:44px}input,select{min-height:44px;border-radius:11px}.result{border-radius:12px;overflow-wrap:anywhere}.notice{border-radius:10px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.actions{flex-wrap:wrap}
@media(max-width:650px){.grid{grid-template-columns:minmax(0,1fr)}main{padding:28px 16px 48px}section{padding:22px 18px;border-radius:18px}}
${reducedMotionStyles}
`;
