"use strict";
/* ============================================================
   test/smoke.js —— node 冒烟测试(无需浏览器)
   路径一:内置启发式 AI(未配置 LLM)
   路径二:模拟 LLM(打桩 LLM.chat,校验 LLM 决策链路 + 失败回退)
   用法:node test/smoke.js [局数,默认 150]
   ============================================================ */

const fs=require("fs");
const path=require("path");
const root=path.join(__dirname,"..");

const N=parseInt(process.argv[2],10)||150;

const stub=`
const view={
  fast:true,logs:0,
  log(){this.logs++}, clearLog(){this.logs=0},
  setStage(){}, setIndicator(){}, render(){},
  async pickSeat(valid){return valid[Math.floor(Math.random()*valid.length)]},
  async confirm(){return Math.random()<0.5},
  async choice(){return 0},
  async askSpeech(){return {key:"pass"}},
  setActions(){}, clearActions(){},
  async openRoleModal(){},
  async openEndModal(){return "stay"},
  async sleep(ms){return new Promise(r=>setTimeout(r,Math.min(ms,1)))},
};
globalThis.localStorage={_d:{},
  getItem(k){return Object.prototype.hasOwnProperty.call(this._d,k)?this._d[k]:null},
  setItem(k,v){this._d[k]=String(v)},
  removeItem(k){delete this._d[k]}};
`;

const engineSrc=["ai.js","llm.js","engine.js"]
  .map(f=>fs.readFileSync(path.join(root,f),"utf8"))
  .join("\n")
  .replace(/^startGame\(\);$/m,""); // 由驱动器手动开局

const driver=`
let llmCalls=0,llmErrors=0;
async function playGame(){
  startGame();
  for(let i=0;i<50000&&!S.over;i++)await new Promise(r=>setTimeout(r,0));
  if(!S.over)throw new Error("对局未终止");
  return {win:S.win,days:S.day};
}
function enableFakeLLM(){
  LLM.save({baseUrl:"http://fake.local/v1",apiKey:"k",model:"fake-model"});
  LLM.chat=async(sys,user)=>{
    llmCalls++;
    if(Math.random()<0.08){llmErrors++;throw new Error("模拟接口故障");}
    const seat=()=>1+Math.floor(Math.random()*9);
    if(user.includes("投票放逐"))return JSON.stringify({target:seat()});
    if(user.includes("狼人行动"))return JSON.stringify({target:seat()});
    if(user.includes("预言家行动"))return JSON.stringify({target:seat()});
    if(user.includes("女巫行动"))return JSON.stringify({save:Math.random()<0.5,poison:null});
    if(user.includes("你出局了"))return JSON.stringify({target:null});
    if(Math.random()<0.1)return JSON.stringify({line:"我觉得"+seat()+"号有问题。",claim:{target:seat(),result:"sha"}});
    return JSON.stringify({line:"我先听听大家的。",claim:null});
  };
}
module.exports={playGame,enableFakeLLM,disableFakeLLM:()=>LLM.clear(),
  stats:()=>({llmCalls,llmErrors})};
`;

const tmp=path.join(__dirname,"_bundle.js");
fs.writeFileSync(tmp,stub+engineSrc+driver);

(async()=>{
  const game=require("./_bundle.js");
  let errors=0;

  // 路径一:启发式
  let wins={good:0,wolf:0},days=0,t0=Date.now();
  for(let i=0;i<N;i++){
    try{
      const r=await game.playGame();
      wins[r.win]++;days+=r.days;
    }catch(e){errors++;console.error("启发式 第"+(i+1)+"局:",e.message);}
  }
  console.log(`[启发式] ${N}局 错误${errors} 好人胜${wins.good} 狼人胜${wins.wolf} 平均${(days/N).toFixed(2)}天 ${Date.now()-t0}ms`);

  // 路径二:模拟 LLM
  const errsBefore=errors;
  wins={good:0,wolf:0};days=0;t0=Date.now();
  game.enableFakeLLM();
  for(let i=0;i<N;i++){
    try{
      const r=await game.playGame();
      wins[r.win]++;days+=r.days;
    }catch(e){errors++;console.error("模拟LLM 第"+(i+1)+"局:",e.message);}
  }
  const st=game.stats();
  console.log(`[模拟LLM] ${N}局 错误${errors-errsBefore} 好人胜${wins.good} 狼人胜${wins.wolf} 平均${(days/N).toFixed(2)}天 LLM调用${st.llmCalls}次(其中故意故障${st.llmErrors}次) ${Date.now()-t0}ms`);

  fs.unlinkSync(tmp);
  process.exit(errors?1:0);
})();
