"use strict";
/* ============================================================
   engine.js —— 游戏引擎:状态机、阶段流程、胜负判定
   只依赖 view 接口(ui.js)与 AI 决策/TemplateSpeech(ai.js),不碰 DOM
   ============================================================ */

let S=null;
const speech=new TemplateSpeech();

const alive=()=>S.players.filter(p=>p.alive);
const aliveWolves=()=>alive().filter(p=>p.role===WOLF);
const byId=id=>S.players[id];
const nameOf=id=>`${id+1}号 ${S.players[id].name}`;
const labelOf=p=>`${p.id+1}号 ${p.name}`;

/* ---------- 状态与渲染快照 ---------- */

function newGame(){
  const roles=shuffle([WOLF,WOLF,WOLF,VILLAGER,VILLAGER,VILLAGER,SEER,WITCH,HUNTER]);
  const humanIdx=Math.floor(Math.random()*9);
  let nameIdx=0;
  S={
    day:0,over:false,win:null,
    humanId:humanIdx,
    revealAll:false,
    witchHeal:true,witchPoison:true,
    saved:false,poisonTarget:null,knifeTarget:null,
    claims:[],wolfJumped:false,
    justDied:new Set(),
    showVotes:null,spokenToday:new Set(),
    players:roles.map((role,i)=>({
      id:i,role,alive:true,human:i===humanIdx,
      name:i===humanIdx?"你":AI_NAMES[nameIdx++],
      susp:Array.from({length:9},()=>0),
      checks:{},
    })),
  };
  view.clearLog();
  render();
}

/* 身份可见性是逻辑规则:全局揭晓 / 自己 / 狼队友 */
function visibleRole(p){
  const human=S.players[S.humanId];
  if(S.revealAll)return p.role;
  if(p.human)return p.role;
  if(human.role===WOLF&&human.alive&&p.role===WOLF)return WOLF;
  return null;
}

function snapshot(){
  return {
    players:S.players.map(p=>{
      const role=visibleRole(p);
      return {
        id:p.id,name:p.name,alive:p.alive,
        roleText:role?ROLE_NAME[role]:null,
        roleClass:role?(role===WOLF?"wolf":""):"",
        votes:S.showVotes&&S.showVotes[p.id]||0,
        justDied:S.justDied&&S.justDied.has(p.id),
      };
    }),
  };
}

function render(){view.render(snapshot());}
function pickSeat(cands,prompt){return view.pickSeat(cands.map(p=>p.id),prompt);}

/* ---------- 夜晚 ---------- */

async function nightPhase(){
  view.setIndicator(`第 ${S.day} 天 · 夜晚`);
  view.setStage("天黑请闭眼",`第 ${S.day} 夜`,true);
  await view.sleep(1100);

  // 狼人
  view.setStage("狼人请睁眼","狼人正在选择猎物",true);
  await view.sleep(900);
  const wolves=aliveWolves();
  if(wolves.length){
    const humanWolf=wolves.find(p=>p.human);
    if(humanWolf){
      const cands=alive().filter(p=>p.role!==WOLF);
      const t=await pickSeat(cands,"选择今晚的猎物");
      S.knifeTarget=t;
      view.clearActions();
      view.log(`你们把獠牙对准了 ${nameOf(t)}。`,"night");
    }else{
      S.knifeTarget=AI.wolfChoose(S);
      view.log("狼人睁开了眼睛,夜色中传来低语。","night");
    }
  }
  await view.sleep(700);

  // 预言家
  view.setStage("预言家请睁眼","命运的水晶泛起微光",true);
  await view.sleep(900);
  const seer=S.players.find(p=>p.role===SEER);
  if(seer&&seer.alive){
    if(seer.human){
      const cands=alive().filter(p=>p.id!==seer.id);
      const t=await pickSeat(cands,"查验一名玩家");
      view.clearActions();
      const res=byId(t).role===WOLF?"wolf":"good";
      seer.checks[t]=res;
      view.log(`【只有你知道】你查验了 ${nameOf(t)} —— ${res==="wolf"?"狼人!":"好人"}`,"gold");
      await view.sleep(800);
    }else{
      AI.seerCheck(S,seer);
      view.log("预言家凝视着水晶,无人知晓他看到了什么。","night");
    }
  }else{
    view.log("预言家的座位空着……水晶蒙上了灰。","night");
  }
  await view.sleep(700);

  // 女巫
  view.setStage("女巫请睁眼","药瓶在黑暗中轻轻作响",true);
  await view.sleep(900);
  S.saved=false;S.poisonTarget=null;
  const witch=S.players.find(p=>p.role===WITCH);
  if(witch&&witch.alive&&(S.witchHeal||S.witchPoison)){
    if(witch.human){
      await humanWitch(witch);
    }else{
      AI.witch(S,witch);
      view.log("女巫掂量着手中的药瓶。","night");
    }
  }else{
    view.log("女巫的药已经用尽,夜风掠过空瓶。","night");
  }
  await view.sleep(800);
}

async function humanWitch(witch){
  const t=S.knifeTarget;
  if(S.witchHeal&&t!=null){
    if(t!==witch.id){
      const save=await view.confirm(
        `今晚 ${nameOf(t)} 被袭击了。要使用仅有的解药吗?`,
        "用解药救人","见死不救"
      );
      if(save){
        S.saved=true;S.witchHeal=false;
        view.log(`【只有你知道】你用解药救下了 ${nameOf(t)}。`,"gold");
      }
    }else{
      view.log("【只有你知道】今晚倒下的是你自己……解药救不了自己。","gold");
      await view.sleep(900);
    }
  }
  if(S.witchPoison){
    const use=await view.choice("要使用毒药吗?(整局仅此一瓶)",["用毒药","不用"]);
    if(use===0){
      const cands=alive().filter(p=>p.id!==witch.id);
      const tgt=await pickSeat(cands,"选择毒杀对象");
      S.poisonTarget=tgt;S.witchPoison=false;
      view.clearActions();
      view.log(`【只有你知道】你把毒药倒进了 ${nameOf(tgt)} 的水杯。`,"gold");
    }
  }
}

/* ---------- 黎明 ---------- */

async function dawnPhase(){
  view.setIndicator(`第 ${S.day} 天 · 白天`);
  view.setStage("天亮了",`第 ${S.day} 天`,false);
  // 毒与刀命中同一人时,只算毒杀(被毒的猎人开不了枪)
  const deaths=[];
  if(S.poisonTarget!=null)deaths.push({id:S.poisonTarget,cause:"poison"});
  if(S.knifeTarget!=null&&!S.saved&&S.knifeTarget!==S.poisonTarget)
    deaths.push({id:S.knifeTarget,cause:"knife"});

  if(!deaths.length){
    view.log(`第 ${S.day} 天清晨:昨夜是平安夜,无人死亡。`,"sys");
    await view.sleep(1200);
  }else{
    S.justDied=new Set(deaths.map(d=>d.id));
    for(const d of deaths){
      byId(d.id).alive=false;
      view.log(`${nameOf(d.id)} 被发现死在了家里。`,"death");
    }
    render();
    await view.sleep(1400);
    S.justDied.clear();
    render();
    for(const d of deaths){
      await hunterCheck(byId(d.id),d.cause);
    }
  }
  if(!S.players[S.humanId].alive&&!S.revealAll){
    S.revealAll=true;
    view.log("你出局了——转入场外,以上帝视角继续观战,所有身份已揭开。","sys");
    render();
  }
}

async function hunterCheck(p,cause){
  if(p.role!==HUNTER)return;
  if(cause==="poison"){
    if(p.human)view.log("【只有你知道】你被毒杀,猎枪从手中滑落——开不了枪。","gold");
    return;
  }
  if(p.human){
    const shoot=await view.confirm("猎人的时刻:你要开枪带走一人吗?","开枪","放弃");
    if(shoot){
      const cands=alive().filter(q=>q.id!==p.id);
      const t=await pickSeat(cands,"猎枪瞄准……");
      view.clearActions();
      killByShot(t);
    }else{
      view.log("猎人收起了枪,沉默地离场。","sys");
    }
  }else{
    const t=AI.topSusp(S,p);
    if(t){
      await view.sleep(700);
      killByShot(t.id);
    }
  }
}

function killByShot(id){
  byId(id).alive=false;
  S.justDied=new Set([id]);
  view.log(`猎人的枪响了!子弹带走了 ${nameOf(id)}。`,"death");
  render();
  setTimeout(()=>{S.justDied.clear();render();},1000);
}

/* ---------- 白天:发言与投票 ---------- */

async function speechPhase(){
  view.setStage("自由发言",`第 ${S.day} 天 · 按座位号轮流发言`,false);
  await view.sleep(700);
  S.spokenToday=new Set();
  for(const p of alive()){
    if(p.human){
      await playerSpeech();
    }else{
      const intent=AI.decide(S,p);
      const line=await speech.generate(p,intent,{nameOf});
      view.log(`${nameOf(p.id)}:${line}`,"speech");
      await view.sleep(1500);
    }
    S.spokenToday.add(p.id);
  }
}

async function playerSpeech(){
  const me=S.players[S.humanId];
  const options=[{key:"pass",label:"我是好人,先过"}];
  if(alive().length>1)options.push({key:"accuse",label:"指认怀疑对象"});
  if(me.role===SEER&&Object.keys(me.checks).length){
    const entries=Object.entries(me.checks);
    const [tid,r]=entries[entries.length-1];
    options.push({key:"claim",label:"跳预言家,报昨晚查验",cls:"gold",
      claim:{target:+tid,result:r==="wolf"?"sha":"water"}});
  }
  if(me.role===WOLF){
    options.push({key:"jump",label:"悍跳预言家",cls:"blood"});
  }
  const res=await view.askSpeech(options,"轮到你发言");

  let line,effect;
  if(res.key==="accuse"){
    const cands=alive().filter(q=>q.id!==me.id);
    const t=await pickSeat(cands,"你怀疑谁");
    line=`我怀疑${nameOf(t)},他的发言有问题。`;
    effect=()=>{for(const v of AI.villageAIs(S))v.susp[t]+=2;};
  }else if(res.key==="claim"){
    const {target,result}=res.claim;
    line=result==="sha"
      ?`我是预言家!昨晚验了${nameOf(target)},是查杀!今天全票出他。`
      :`我是预言家,昨晚验了${nameOf(target)},是金水,他可以放一放。`;
    effect=()=>AI.applyClaim(S,{seer:me.id,target,result,fake:false});
  }else if(res.key==="jump"){
    const cands=alive().filter(q=>q.id!==me.id&&q.role!==WOLF);
    if(!cands.length){
      line="我是好人,先听大家的。";
    }else{
      const t=await pickSeat(cands,"报一个假的查杀对象");
      S.wolfJumped=true;
      line=`我是预言家!昨晚验了${nameOf(t)},是查杀!`;
      effect=()=>AI.applyClaim(S,{seer:me.id,target:t,result:"sha",fake:true});
    }
  }else if(res.key==="text"){
    line=res.text;
  }else{
    line="我是好人,先听大家的。";
  }

  view.clearActions();
  view.log(`${nameOf(me.id)}:${line}`,"speech");
  if(effect)effect();
}

async function votePhase(){
  view.setStage("投票放逐",`第 ${S.day} 天 · 得票最多者出局,平票则无人出局`,false);
  await view.sleep(600);
  const votes=new Map();
  for(const p of alive()){
    let t;
    if(p.human){
      const cands=alive().filter(q=>q.id!==p.id);
      t=await pickSeat(cands,"投出一票");
      view.clearActions();
    }else{
      t=AI.vote(S,p);
      await view.sleep(280);
    }
    if(t!=null){
      if(!votes.has(t))votes.set(t,[]);
      votes.get(t).push(p.id);
    }
  }
  const counts={};
  for(const [t,voters]of votes){
    counts[t]=voters.length;
    view.log(`${nameOf(t)} ← ${voters.map(id=>id+1+"号").join("、")}`,"sys");
  }
  S.showVotes=counts;
  render();
  await view.sleep(1800);
  S.showVotes=null;
  render();

  let maxTarget=null,maxCount=0,tie=false;
  for(const [t,n]of Object.entries(counts)){
    if(n>maxCount){maxCount=n;maxTarget=+t;tie=false;}
    else if(n===maxCount)tie=true;
  }
  if(maxTarget==null||tie){
    view.log("平票——今天没有人被放逐,村庄在争执中入夜。","sys");
    return;
  }
  const exiled=byId(maxTarget);
  exiled.alive=false;
  S.justDied=new Set([maxTarget]);
  view.log(`${nameOf(maxTarget)} 被村民投票放逐,离开了村庄。`,"death");
  render();
  await view.sleep(1300);
  S.justDied.clear();
  render();
  if(exiled.human&&!S.revealAll){
    S.revealAll=true;
    view.log("你被放逐了——转入场外,以上帝视角继续观战,所有身份已揭开。","sys");
    render();
  }else if(!exiled.human){
    view.log(pick([
      `${nameOf(maxTarget)} 走前高喊:"我是冤枉的!"`,
      `${nameOf(maxTarget)} 冷笑一声,一言不发地离开了。`,
      `${nameOf(maxTarget)} 叹了口气:"你们会后悔的。"`,
    ]),"sys");
  }
  await hunterCheck(exiled,"exile");
  if(!S.players[S.humanId].alive&&!S.revealAll){
    S.revealAll=true;
    view.log("你出局了——以上帝视角继续观战,所有身份已揭开。","sys");
    render();
  }
}

/* ---------- 胜负与终局 ---------- */

function checkWin(){
  const w=aliveWolves().length;
  const g=alive().length-w;
  if(w===0){S.over=true;S.win="good";return true;}
  if(w>=g){S.over=true;S.win="wolf";return true;}
  return false;
}

async function endGame(){
  S.revealAll=true;
  render();
  view.clearActions();
  const goodWin=S.win==="good";
  view.setStage(goodWin?"黎明降临":"狼群统治了村庄",
    goodWin?"所有狼人出局":"狼人不再需要伪装",goodWin);
  view.setIndicator("对局结束");
  view.log(goodWin?"所有狼人出局——好人胜利!":"狼人屠城——狼人胜利!",goodWin?"gold":"death");
  const r=await view.openEndModal({
    goodWin,
    story:goodWin
      ?"最后一头狼倒下了。晨光爬上山脊,幸存的村民彼此搀扶着走出家门。"
      :"夜再也不会结束。狼人撕下伪装,空荡的村庄只剩下风声。",
    revealList:S.players.map(p=>({
      who:`${p.id+1}号 ${p.name}${p.alive?"":"(出局)"}`,
      role:ROLE_NAME[p.role],
      cls:ROLE_TINT[p.role],
    })),
  });
  if(r==="stay"){
    view.setActions([{label:"再来一局",cls:"primary",onClick:()=>startGame()}],"对局已结束");
  }else{
    startGame();
  }
}

/* ---------- 主流程 ---------- */

async function runGame(){
  const me=S.players[S.humanId];
  await view.openRoleModal({
    roleName:ROLE_NAME[me.role],
    roleClass:ROLE_CLASS[me.role],
    desc:me.role===VILLAGER
      ?"没有技能,但你的耳朵和推理就是武器。听发言、看投票,把狼人找出来。"
      :ROLE_DESC[me.role],
    matesText:me.role===WOLF
      ?"你的同伴:"+S.players.filter(p=>p.role===WOLF&&!p.human).map(labelOf).join("、")
      :null,
  });
  while(!S.over){
    S.day++;
    await nightPhase();
    await dawnPhase();
    if(checkWin())break;
    await speechPhase();
    await votePhase();
    if(checkWin())break;
  }
  if(S.over)await endGame();
}

function startGame(){
  newGame();
  view.setIndicator("第 1 天 · 夜晚");
  runGame();
}

startGame();
