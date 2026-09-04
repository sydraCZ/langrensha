"use strict";
/* ============================================================
   engine.js —— 游戏引擎:状态机、阶段流程、胜负判定
   只依赖 view 接口(ui.js)、AI 决策(ai.js)与 LLM 大脑(llm.js),不碰 DOM
   ============================================================ */

var S=null;
const brain=new HybridBrain();

const alive=()=>S.players.filter(p=>p.alive);
const aliveWolves=()=>alive().filter(p=>p.role===WOLF);
const byId=id=>S.players[id];
/* 座位号是唯一标识;玩家昵称属于 UI 展示配置(ui.js),逻辑层不感知 */
const seatOf=id=>`${id+1}号`;

/* 公开事件入档:同局共同记忆。kind="speech" 的条目在更早的天会被压缩成要点,
   其余(死亡/放逐/平票)逐字保留 */
function record(text,kind){
  S.transcript.push({day:S.day,text,kind:kind||"note"});
}

/* 复盘档案:上帝视角,记录所有事件(含私信)。与 transcript 分离,
   transcript 是 LLM 记忆,journal 是人类复盘 */
function journalAdd(entry){
  S.journal.push({seq:S.journal.length+1,...entry});
}

function buildJournalText(){
  const lines=[];
  lines.push("===== 月夜狼人杀 · 复盘 =====\n");
  lines.push("【开局 · 身份分配】");
  for(const p of S.players)lines.push(`  ${seatOf(p.id)}: ${ROLE_NAME[p.role]}`);
  lines.push("");
  const days={};
  for(const e of S.journal){
    if(e.phase==="init"||e.phase==="end")continue;
    const d=days[e.day]||(days[e.day]=[]);
    d.push(e);
  }
  const dayNums=Object.keys(days).map(Number).sort((a,b)=>a-b);
  const phaseLabel={night:"夜晚",dawn:"黎明",speech:"白天发言",vote:"投票放逐",api:"LLM 调用"};
  for(const day of dayNums){
    const events=days[day];
    let lastPhase=null;
    for(const e of events){
      if(e.phase!==lastPhase){
        lines.push(`【第 ${day} 天 · ${phaseLabel[e.phase]||e.phase}】`);
        lastPhase=e.phase;
      }
      lines.push(`  ${e.text}`);
    }
    lines.push("");
  }
  const ends=S.journal.filter(e=>e.phase==="end");
  if(ends.length){
    lines.push("【终局】");
    for(const e of ends)lines.push(`  ${e.text}`);
  }
  return lines.join("\n");
}

/* ---------- 状态与渲染快照 ---------- */

function newGame(){
  const roles=shuffle([WOLF,WOLF,WOLF,VILLAGER,VILLAGER,VILLAGER,SEER,WITCH,HUNTER]);
  const humanIdx=Math.floor(Math.random()*9);
  S={
    day:0,over:false,win:null,
    humanId:humanIdx,
    revealAll:false,
    witchHeal:true,witchPoison:true,
    saved:false,poisonTarget:null,knifeTarget:null,
    claims:[],wolfJumped:false,
    transcript:[],
    justDied:new Set(),
    showVotes:null,spokenToday:new Set(),
    players:roles.map((role,i)=>({
      id:i,role,alive:true,human:i===humanIdx,
      susp:Array.from({length:9},()=>0),
      checks:{},
    })),
  };
  S.journal=[];
  const roleLines=S.players.map(p=>`${seatOf(p.id)}: ${ROLE_NAME[p.role]}`).join("\n  ");
  journalAdd({day:0,phase:"init",type:"roles",text:`身份分配:\n  ${roleLines}`});
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
        id:p.id,alive:p.alive,isHuman:p.human,
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
  S.knifeTarget=null; /* 每晚清零,避免沿用上夜刀口 */
  await view.sleep(1100);

  // 狼人
  view.setStage("狼人请睁眼","狼人正在选择猎物",true);
  await view.sleep(900);
  const wolves=aliveWolves();
  if(wolves.length){
    const humanWolf=wolves.find(p=>p.human);
    if(humanWolf){
      const candsList = alive().filter(p => ruleWolfCanTarget(humanWolf.id)(p.id));
      const t = await pickSeat(candsList, "选择今晚的猎物");
      S.knifeTarget=t;
      view.clearActions();
      view.log(`你们把獠牙对准了 ${seatOf(t)}。`,"night");
    }else{
      S.knifeTarget=await brain.wolfTarget(S);
      view.log("狼人睁开了眼睛,夜色中传来低语。","night");
    }
  }
  if(S.knifeTarget!=null){
    journalAdd({day:S.day,phase:"night",type:"wolf_knife",
      text:`🐺 狼人选择袭击 ${seatOf(S.knifeTarget)}`});
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
      view.log(`【只有你知道】你查验了 ${seatOf(t)} —— ${res==="wolf"?"狼人!":"好人"}`,"gold");
      journalAdd({day:S.day,phase:"night",type:"seer_check",
        text:`🔮 预言家(${seatOf(seer.id)}) 查验 ${seatOf(t)} → ${res==="wolf"?"狼人":"好人"}`});
      await view.sleep(800);
    }else{
      const t=await brain.seerTarget(S,seer);
      if(t!=null){
        seer.checks[t]=byId(t).role===WOLF?"wolf":"good";
        journalAdd({day:S.day,phase:"night",type:"seer_check",
          text:`🔮 预言家(${seatOf(seer.id)}) 查验 ${seatOf(t)} → ${byId(t).role===WOLF?"狼人":"好人"}`});
      }
      view.log("预言家凝视着水晶,无人知晓他看到了什么。","night");
    }
  }else{
    view.log("预言家的座位空着……水晶蒙上了灰。","night");
    record("预言家已出局，今晚无人查验。","note");
    journalAdd({day:S.day,phase:"night",type:"seer_check",
      text:"🔮 预言家已出局，今晚无人查验。"});
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
      const act=await brain.witchAct(S,witch);
      if(act.save){S.saved=true;S.witchHeal=false;
        journalAdd({day:S.day,phase:"night",type:"witch_save",
          text:`🧪 女巫(${seatOf(witch.id)}) 使用解药救下 ${seatOf(S.knifeTarget)}`});
      }
      if(act.poison!=null){S.poisonTarget=act.poison;S.witchPoison=false;
        journalAdd({day:S.day,phase:"night",type:"witch_poison",
          text:`☠️ 女巫(${seatOf(witch.id)}) 毒杀 ${seatOf(act.poison)}`});
      }
      if(!act.save&&act.poison==null){
        journalAdd({day:S.day,phase:"night",type:"witch_skip",
          text:`🧪 女巫(${seatOf(witch.id)}) 今夜不用药`});
      }
      view.log("女巫掂量着手中的药瓶。","night");
    }
  }else{
    view.log("女巫的药已经用尽,夜风掠过空瓶。","night");
    record("女巫的药已经用尽，今晚无法用药。","note");
    journalAdd({day:S.day,phase:"night",type:"witch_empty",
      text:`🧪 女巫(${seatOf(witch.id)}) 药已全部用完`});
  }
  await view.sleep(800);
}

async function humanWitch(witch){
  const t=S.knifeTarget;
  if (S.witchHeal && t != null) {
    if (t !== witch.id || ruleWitchCanSaveSelf()) {
      const save = await view.confirm(
        `今晚 ${seatOf(t)} 被袭击了。要使用仅有的解药吗?`,
        "用解药救人", "见死不救"
      );
      if (save) {
        S.saved = true; S.witchHeal = false;
        view.log(`【只有你知道】你用解药救下了 ${seatOf(t)}。`, "gold");
        journalAdd({day: S.day, phase: "night", type: "witch_save",
          text: `🧪 女巫(${seatOf(witch.id)}) 使用解药救下 ${seatOf(t)}`});
      }
    } else {
      view.log("【只有你知道】今晚倒下的是你自己……解药救不了自己。", "gold");
      journalAdd({day: S.day, phase: "night", type: "witch_blocked",
        text: `🧪 女巫(${seatOf(witch.id)}) 被袭击,解药不能救自己`});
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
      view.log(`【只有你知道】你把毒药倒进了 ${seatOf(tgt)} 的水杯。`,"gold");
      journalAdd({day:S.day,phase:"night",type:"witch_poison",
        text:`☠️ 女巫(${seatOf(witch.id)}) 毒杀 ${seatOf(tgt)}`});
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
    record("清晨公布:昨夜是平安夜——女巫用了解药救下了一人,无人死亡。","note");
    journalAdd({day:S.day,phase:"dawn",type:"peaceful_night",
      text:"☀️ 平安夜——女巫用了解药,无人死亡"});
    await view.sleep(1200);
  }else{
    S.justDied=new Set(deaths.map(d=>d.id));
    for(const d of deaths){
      byId(d.id).alive=false;
      view.log(`${seatOf(d.id)} 被发现死在了家里。`,"death");
      record(`清晨公布:${seatOf(d.id)} 死亡。`,"note");
      journalAdd({day:S.day,phase:"dawn",type:"death",
        text:`💀 ${seatOf(d.id)}(${ROLE_NAME[byId(d.id).role]}) 死亡 [${d.cause==="knife"?"狼刀":"毒药"}]`});
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
  if (p.role !== HUNTER) return;
  if (cause === "poison" && !ruleHunterCanShootOnPoison()) {
    if (p.human) view.log("【只有你知道】你被毒杀,猎枪从手中滑落——开不了枪。", "gold");
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
      record("猎人的枪没有响。","note");
      journalAdd({day:S.day,phase:"dawn",type:"hunter_skip",
        text:`🔫 猎人(${seatOf(p.id)}) 放弃开枪`});
    }
  }else{
    const t=await brain.hunterTarget(S,p);
    if(t!=null){
      await view.sleep(700);
      killByShot(t);
    }else{
      journalAdd({day:S.day,phase:"dawn",type:"hunter_skip",
        text:`🔫 猎人(${seatOf(p.id)}) 放弃开枪`});
    }
  }
}

function killByShot(id){
  byId(id).alive=false;
  S.justDied=new Set([id]);
  view.log(`猎人的枪响了!子弹带走了 ${seatOf(id)}。`,"death");
  record(`猎人开枪,${seatOf(id)} 被带走。`,"note");
  journalAdd({day:S.day,phase:"dawn",type:"hunter_shot",
    text:`🔫 猎人开枪,${seatOf(id)}(${ROLE_NAME[byId(id).role]}) 被带走`});
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
      const r=await brain.speech(S,p,{seatOf});
      if(r.wolfJump)S.wolfJumped=true;
      if(r.claim){
        AI.applyClaim(S,{seer:p.id,target:r.claim.target,result:r.claim.result,
          fake:p.role!==SEER});
      }
      view.log(`${seatOf(p.id)}:${r.line}`,"speech");
      record(`${seatOf(p.id)}:${r.line}`,"speech");
      journalAdd({day:S.day,phase:"speech",type:"speech",
        text:`💬 ${seatOf(p.id)}(${ROLE_NAME[p.role]}):${r.line}`});
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
    line=`我怀疑${seatOf(t)},他的发言有问题。`;
    effect=()=>{for(const v of AI.villageAIs(S))v.susp[t]+=2;};
  }else if(res.key==="claim"){
    const {target,result}=res.claim;
    line=result==="sha"
      ?`我是预言家!昨晚验了${seatOf(target)},是查杀!今天全票出他。`
      :`我是预言家,昨晚验了${seatOf(target)},是金水,他可以放一放。`;
    effect=()=>AI.applyClaim(S,{seer:me.id,target,result,fake:false});
  }else if(res.key==="jump"){
    const cands=alive().filter(q=>q.id!==me.id&&q.role!==WOLF);
    if(!cands.length){
      line="我是好人,先听大家的。";
    }else{
      const t=await pickSeat(cands,"报一个假的查杀对象");
      S.wolfJumped=true;
      line=`我是预言家!昨晚验了${seatOf(t)},是查杀!`;
      effect=()=>AI.applyClaim(S,{seer:me.id,target:t,result:"sha",fake:true});
    }
  }else if(res.key==="text"){
    line=res.text;
  }else{
    line="我是好人,先听大家的。";
  }

  view.clearActions();
  view.log(`${seatOf(me.id)}:${line}`,"speech");
  record(`${seatOf(me.id)}:${line}`,"speech");
  journalAdd({day:S.day,phase:"speech",type:"speech",
    text:`💬 ${seatOf(me.id)}(${ROLE_NAME[me.role]}):${line}`});
  if(effect)effect();
}

async function votePhase(){
  view.setStage("投票放逐",`第 ${S.day} 天 · 得票最多者出局,平票则无人出局`,false);
  await view.sleep(600);
  const voters=alive();
  const humanVoter=voters.find(p=>p.human);

  // 人类选票与 AI 选票并行发起(AI 走 LLM 时每票一次调用,并行可省大量等待)
  const humanP=humanVoter
    ?pickSeat(voters.filter(q=>q.id!==humanVoter.id),"投出一票")
      .then(id=>{view.clearActions();return {id:humanVoter.id,t:id};})
    :Promise.resolve(null);
  const results=await Promise.all([
    ...voters.filter(p=>!p.human).map(p=>{
      const ownSpeech=S.transcript
        .filter(e=>e.day===S.day&&e.kind==="speech"&&e.text.startsWith(`${p.id+1}号:`))
        .map(e=>e.text).join(" / ");
      return brain.vote(S,p,ownSpeech||null).then(v=>({id:p.id,t:v.target,reason:v.reason||""}));
    }),
    humanP,
  ]);

  for(const r of results){
    if(r&&r.t!=null){
      const voter=byId(r.id);
      const roleInfo=S.revealAll?`(${ROLE_NAME[voter.role]})`:"";
      const disguiseNote = S.revealAll && voter.role===WOLF && r.reason
        ? `【伪装】${r.reason}` : r.reason;
      const reasonNote = r.reason ? ` — "${disguiseNote}"` : "";
      journalAdd({day:S.day,phase:"vote",type:"vote",
        text:`🗳️ ${seatOf(r.id)}${roleInfo} 投给 ${seatOf(r.t)}${reasonNote}`});
    }
  }

  const votes=new Map();
  for(const r of results){
    if(r&&r.t!=null){
      if(!votes.has(r.t))votes.set(r.t,[]);
      votes.get(r.t).push(r.id);
    }
  }
  const counts={};
  for(const [t,vs]of votes){
    counts[t]=vs.length;
    view.log(`${seatOf(t)} ← ${vs.map(id=>id+1+"号").join("、")}`,"sys");
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
  if(maxTarget!=null&&!tie)record(`放逐${seatOf(maxTarget)}(${maxCount}票)`, "vote");
  else if(votes.size)record("投票平票,无人被放逐。", "vote");
  if(maxTarget==null||tie){
    view.log("平票——今天没有人被放逐,村庄在争执中入夜。","sys");
    journalAdd({day:S.day,phase:"vote",type:"tie",text:"🗳️ 平票,无人被放逐"});
    return;
  }
  const exiled=byId(maxTarget);
  exiled.alive=false;
  S.justDied=new Set([maxTarget]);
  view.log(`${seatOf(maxTarget)} 被村民投票放逐,离开了村庄。`,"death");
  journalAdd({day:S.day,phase:"vote",type:"exile",
    text:`⚖️ ${seatOf(maxTarget)}(${ROLE_NAME[exiled.role]}) 被放逐(${maxCount}票)`});
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
      `${seatOf(maxTarget)} 走前高喊:"我是冤枉的!"`,
      `${seatOf(maxTarget)} 冷笑一声,一言不发地离开了。`,
      `${seatOf(maxTarget)} 叹了口气:"你们会后悔的。"`,
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

function checkWin() {
  const w = aliveWolves().length;
  const g = alive().length - w;
  if (w === 0) { S.over = true; S.win = "good"; return true; }
  if (!ruleIsAllIn()) {
    const godAlive = alive().filter(p => !p.role.includes("villager")).length;
    const vilAlive = alive().filter(p => p.role === VILLAGER).length;
    if (w >= godAlive || w >= vilAlive) { S.over = true; S.win = "wolf"; return true; }
  } else if (w >= g) {
    S.over = true; S.win = "wolf"; return true;
  }
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
  record(goodWin?"所有狼人出局,好人胜利。":"狼人屠城,狼人胜利。","note");
  journalAdd({day:S.day,phase:"end",type:"result",
    text:`🏁 游戏结束 · ${goodWin?"好人胜利":"狼人胜利"} · 共 ${S.day} 天`});
  const aliveList=S.players.filter(p=>p.alive).map(p=>`${seatOf(p.id)}(${ROLE_NAME[p.role]})`).join("、");
  journalAdd({day:S.day,phase:"end",type:"survivors",
    text:`幸存者: ${aliveList||"无"}`});
  const r=await view.openEndModal({
    goodWin,
    story:goodWin
      ?"最后一头狼倒下了。晨光爬上山脊,幸存的村民彼此搀扶着走出家门。"
      :"夜再也不会结束。狼人撕下伪装,空荡的村庄只剩下风声。",
    revealList:S.players.map(p=>({
      id:p.id,alive:p.alive,
      role:ROLE_NAME[p.role],
      cls:ROLE_TINT[p.role],
    })),
    journalText:buildJournalText(),
  });
  if(r==="stay"){
    view.setActions([{label:"再来一局",cls:"primary",onClick:()=>startGame()}],"对局已结束");
  }else if(r==="replay"){
    await view.openReplayModal(buildJournalText());
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
      ?"你的同伴:"+S.players.filter(p=>p.role===WOLF&&!p.human).map(p=>seatOf(p.id)).join("、")
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
  view.log(LLM.ready()
    ?`本局 AI 由大模型驱动(${LLM.config.model}),它们记得本局每一天的发言与投票。`
    :"本局为内置规则 AI——点右上「AI 设置」接入大模型后,AI 将自己推理。","sys");
  runGame();
}

view.openLanding().then(()=>startGame());
