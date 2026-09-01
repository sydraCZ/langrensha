"use strict";
/* ============================================================
   llm.js —— LLM 大脑:OpenAI 兼容端点(DeepSeek/Qwen/Kimi/Ollama…)
   每个决策点把「角色视角 + 私有信息 + 本局完整对局记录」交给
   大模型判断;未配置或调用失败时回退到 ai.js 的启发式决策
   ============================================================ */

const LLM={
  STORAGE_KEY:"ww_llm_config",
  _loaded:false,
  config:null,
  lastChars:0, /* 最近一次请求的字符数,用于观察压缩效果 */

  load(){
    this._loaded=true;
    try{
      this.config=JSON.parse(localStorage.getItem(this.STORAGE_KEY))||null;
    }catch(e){this.config=null;}
    return this.config;
  },
  save(cfg){
    this.config=cfg;this._loaded=true;
    try{localStorage.setItem(this.STORAGE_KEY,JSON.stringify(cfg));}catch(e){}
  },
  clear(){
    this.config=null;this._loaded=true;
    try{localStorage.removeItem(this.STORAGE_KEY);}catch(e){}
  },
  ready(){
    if(!this._loaded)this.load();
    const c=this.config;
    return !!(c&&c.baseUrl&&c.apiKey&&c.model);
  },

  async chat(system,user,opts){
    const cfg=this.config;
    if(!cfg)throw new Error("未配置 LLM");
    this.lastChars=String(system).length+String(user).length;
    const o=Object.assign({timeout:45000,temperature:0.8,maxTokens:400},opts);
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),o.timeout);
    try{
      const res=await fetch(cfg.baseUrl.replace(/\/+$/,"")+"/chat/completions",{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+cfg.apiKey},
        body:JSON.stringify({
          model:cfg.model,
          messages:[
            {role:"system",content:system},
            {role:"user",content:user},
          ],
          temperature:o.temperature,
          max_tokens:o.maxTokens,
        }),
        signal:ctrl.signal,
      });
      if(!res.ok)throw new Error("HTTP "+res.status);
      const data=await res.json();
      const text=data&&data.choices&&data.choices[0]&&data.choices[0].message
        &&data.choices[0].message.content;
      if(typeof text!=="string"||!text.trim())throw new Error("空响应");
      return text;
    }finally{clearTimeout(timer);}
  },

  /* 从回复中抽取 JSON(容忍 markdown 代码块、思考过程、前后废话) */
  async chatJSON(system,user,opts){
    const raw=await this.chat(system,user,Object.assign({temperature:0.7},opts));
    const m=raw.match(/\{[\s\S]*\}/);
    if(!m)throw new Error("回复中未找到 JSON");
    return JSON.parse(m[0]);
  },
};

/* ---------- 提示词构建 ---------- */

function llmSeatName(p){
  return p.human?`#${p.id+1}(人类玩家)`:`#${p.id+1}`;
}

/* 发言记录前缀 "3号:" → "#3:"(座位号即唯一标识,记录里没有昵称)。
   注意:必须用「只匹配前缀 + 冒号前瞻」,否则贪婪匹配会把冒号后的发言内容整个吞掉,只剩 "#3"。 */
function llmClean(text){
  return text
    .replace(/^(\d+)号(?=:)/,"#$1")
    .replace(/^清晨公布:(\d+)号(?= )/,"清晨公布:#$1");
}

/* 把发言记录压成一行要点(保留"查杀/金水/怀疑/投X"等判断骨架,去掉套话) */
function llmSpeechDigest(list,maxLen){
  const raw=list.map(e=>e.text).join(" | ");
  const noise=/^(我是好人|先过|我先过|我先听听大家的|我先听大家的|没什么想说的|随大流|没意见|先听|无)[,.。！! ]*/g;
  const kept=raw.replace(noise,"").replace(/\s{2,}/g," ").replace(/\s\|\s/g,"|");
  if(!kept)return "";
  return kept.length<=maxLen?kept:kept.slice(0,maxLen)+"…";
}

/* 压缩版记忆:最近一天(当前任务发生的那一轮)发言保留原文;更早的天整块压缩 */
function llmCompact(S,fullDay){
  if(!S.transcript||!S.transcript.length)return "(对局刚开始,还没有公开事件)";
  const days={};
  for(const e of S.transcript){
    const d=days[e.day]||(days[e.day]={speech:[],rest:[]});
    (e.kind==="speech"?d.speech:d.rest).push(e);
  }
  const out=[];
  const nums=Object.keys(days).map(Number).sort((a,b)=>a-b);
  for(const d of nums){
    const day=days[d];
    const L=`【第${d}天】 `;
    if(d===fullDay){
      out.push(L+day.rest.map(e=>llmClean(e.text)).join(" / ")
        +(day.speech.length?" | "+day.speech.map(e=>llmClean(e.text)).join(" | "):""));
    }else{
      const parts=day.rest.map(e=>llmClean(e.text));
      const dig=llmSpeechDigest(day.speech.map(e=>llmClean(e.text)),72);
      if(dig)parts.push("发言要点:"+dig);
      out.push(L+parts.join(" / ")+"。");
    }
  }
  return out.join("\n");
}

function llmTranscript(S,fullDay){
  return llmCompact(S,fullDay);
}

/* ---------- 静态系统提示词:每次调用完全相同,便于 prompt caching ----------
   只含游戏总览 + 角色枚举 + 规则 + 输出格式,不含任何玩家私有信息 */
function llmSystemStatic(){
  return "你在玩一局 9 人标准狼人杀。本局只有这 5 种角色,没有其他角色,不要脑补不存在的角色:狼人×3、村民×3、预言家×1、女巫×1、猎人×1。明确没有守卫、白痴、骑士、猎人以外的枪手等。\n"
    +"规则:\n"
    +"- 夜晚:狼人共同选择袭击目标→预言家查验一名玩家阵营→女巫决定用解药或毒药(整局各限一次)。\n"
    +"- 狼人夜里只能袭击非狼人阵营的存活玩家,不能选自己或狼队友。本局不存在「自刀」策略。任何玩家在发言中也绝不推测或提及自刀——平安夜只可能是女巫用了解药,死亡只可能是狼刀或毒药。\n"
    +"- 女巫的解药不能救自己。\n"
    +"- 白天:按座位号轮流发言,然后全员投票放逐。得票最多者出局;平票无人出局。\n"
    +"- 猎人被袭击或被放逐时可开枪带走一名存活玩家;被毒杀则不能开枪。\n"
    +"- 胜负:狼全部出局则好人胜;狼人数不少于好人数则狼人胜。\n"
    +"游戏记忆格式:本局对局记忆已经压缩——最近一天为原文,更早的天为摘要(发言可能被截断,以「|」分隔)。座位用 #1~#9 表示,对局记录中的前缀如「#3:发言内容」中 #3 即 3 号玩家。\n"
    +"行为要求:完全代入角色,只依据记忆与你的私有信息推理。狼人必须伪装撒谎,好人要找狼。回答必须是合法 JSON,除 JSON 外不要输出任何内容。";
}

/* ---------- 玩家上下文(动态):角色视角 + 私有信息 + 座位表 ----------
   每次调用都不同,放在 user 消息中,不污染 system 静态规则 */
function llmPlayerContext(S,p){
  let priv="";
  if(p.role===WOLF){
    const mates=S.players.filter(q=>q.role===WOLF&&q.id!==p.id);
    priv="你的狼队友:"+mates.map(q=>`#${q.id+1}${q.alive?"":"(已出局)"}`).join("、")
      +"。狼人夜里共同决定袭击目标,白天必须隐藏身份、伪装好人。";
  }else if(p.role===SEER){
    const ks=Object.keys(p.checks);
    priv=ks.length
      ?"你的查验记录:"+ks.map(t=>`#${+t+1}=${p.checks[t]==="wolf"?"狼":"好"}`).join("、")
      :"你还没有查验过任何人。";
  }else if(p.role===WITCH){
    priv=`你的解药${S.witchHeal?"未使用":"已用完"},毒药${S.witchPoison?"未使用":"已用完"}。解药不能救自己。`;
  }
  const seats=S.players
    .map(q=>`#${q.id+1}${q.alive?"":"(已出局)"}`)
    .join("、");
  return `你扮演 ${llmSeatName(p)},身份是【${ROLE_NAME[p.role]}】。\n`
    +(priv?`私有信息:${priv}\n`:"")
    +`座位表:${seats}`;
}

function llmSituation(S){
  const alive=S.players.filter(p=>p.alive).map(p=>`#${p.id+1}`).join("、");
  const dead=S.players.filter(p=>!p.alive).map(p=>`#${p.id+1}`).join("、")||"无";
  const todaySpoken=S.spokenToday?Array.from(S.spokenToday).sort((a,b)=>a-b)
    .map(id=>`#${id+1}`).join("、")||"无":null;
  return `【当前局势】 存活:${alive} | 已出局:${dead}`
    +(todaySpoken?` | 今日已发言:${todaySpoken}`:"")
    +(S.justDied&&S.justDied.size?` | 今晨死亡:${Array.from(S.justDied).sort((a,b)=>a-b).map(id=>`#${id+1}`).join("、")}`:"");
}

function llmUser(S,p,task){
  return "===角色视角===\n"+llmPlayerContext(S,p)
    +"\n\n===本局对局记忆(已压缩)===\n"+llmTranscript(S,S.day)
    +"\n\n===当前局势===\n"+llmSituation(S)
    +"\n\n===当前任务===\n"+task;
}

/* ---------- HybridBrain:统一决策入口 ----------
   LLM 可用则问大模型;失败或未配置则用 ai.js 启发式 */

class HybridBrain{
  constructor(){this._tpl=new TemplateSpeech();}

  /* 座位号(1~9)→ id(0~8),校验存活/排除自己,非法返回 null */
  _seatId(S,num,{alive=true,exclude=null}={}){
    const id=Number(num)-1;
    if(!Number.isInteger(id)||id<0||id>8)return null;
    const p=S.players[id];
    if(alive&&!p.alive)return null;
    if(exclude!=null&&id===exclude)return null;
    return id;
  }

  _ask(S,p,task,opts){
    return LLM.chatJSON(llmSystemStatic(),llmUser(S,p,task),opts);
  }

  /* 发言 → {line, claim:{target,result}|null, wolfJump:boolean} */
  async speech(S,p,ctx){
    if(LLM.ready()){
      try{
        const j=await this._ask(S,p,
          "轮到你发言。结合今日已发言的人给出1~3句中文口语发言(像真人)。输出 {\"line\":\"…\",\"claim\":null};跳预言家时才把 claim 填成 {\"target\":座位号,\"result\":\"sha\"或\"water\"},否则 null。");
        const line=typeof j.line==="string"?j.line.trim().slice(0,300):"";
        if(line){
          let claim=null;
          if(j.claim&&j.claim.target!=null){
            const id=this._seatId(S,j.claim.target,{exclude:p.id});
            if(id!=null)claim={target:id,result:j.claim.result==="water"?"water":"sha"};
          }
          return {line,claim,wolfJump:false};
        }
      }catch(e){console.warn("LLM 发言回退:",e.message);}
    }
    const intent=AI.decide(S,p);
    const line=await this._tpl.generate(p,intent,ctx);
    return {line,claim:intent.claim||null,wolfJump:!!intent.wolfJump};
  }

  /* 投票 → 目标 id */
  async vote(S,p){
    if(LLM.ready()){
      try{
        const j=await this._ask(S,p,
          '现在全场投票放逐。候选是「除你自己外、当前存活的全部玩家」。选出你认为最该出局的人(不能投自己,必须是存活玩家)。输出 {"target":座位号}。');
        const id=this._seatId(S,j.target,{exclude:p.id});
        if(id!=null)return id;
      }catch(e){console.warn("LLM 投票回退:",e.message);}
    }
    return AI.vote(S,p);
  }

  /* 狼人刀口 → 目标 id(以一名存活 AI 狼的视角问整个狼队) */
  async wolfTarget(S){
    const wolf=S.players.find(p=>p.alive&&p.role===WOLF&&!p.human);
    if(wolf&&LLM.ready()){
      try{
        const j=await this._ask(S,wolf,
          '天黑了,狼人行动。你们要选择今晚袭击谁(不能自刀,不能袭击狼队友,必须选存活的好人阵营玩家)。输出 {"target":座位号}。');
        const id=this._seatId(S,j.target,{exclude:wolf.id});
        if(id!=null&&S.players[id].role!==WOLF)return id;
      }catch(e){console.warn("LLM 刀口回退:",e.message);}
    }
    return AI.wolfChoose(S);
  }

  /* 预言家验人 → 目标 id */
  async seerTarget(S,seer){
    if(LLM.ready()){
      try{
        const j=await this._ask(S,seer,
          '天黑了,预言家行动。选择今晚你要查验的玩家(不能查自己,不要查已验过的人)。输出 {"target":座位号}。');
        const id=this._seatId(S,j.target,{exclude:seer.id});
        if(id!=null&&!(id in seer.checks))return id;
      }catch(e){console.warn("LLM 验人回退:",e.message);}
    }
    const t=AI.seerPick(S,seer);
    return t!=null?t:null;
  }

  /* 女巫用药 → {save:boolean, poison:id|null} */
  async witchAct(S,witch){
    if(LLM.ready()){
      try{
        const knifed=S.knifeTarget!=null
          ?`今晚 #${S.knifeTarget+1} 被狼人袭击`
          :"今晚没有人被袭击";
        let task=`天黑了,女巫行动。${knifed}。\n`
          +'输出 {"save":true或false,"poison":座位号或null}。'
          +`save=true 表示用解药救今晚被袭击的人${S.witchHeal?"":"(你的解药已用完,填 false)"}`
          +`${S.knifeTarget===witch.id?"(今晚被袭击的是你自己,解药救不了自己,填 false)":";"}`
          +`poison 填你想毒杀的存活玩家座位号${S.witchPoison?"":"(毒药已用完,填 null)"},不想用毒药填 null。`;
        const j=await this._ask(S,witch,task);
        const save=j.save===true&&S.witchHeal&&S.knifeTarget!=null&&S.knifeTarget!==witch.id;
        let poison=null;
        if(j.poison!=null&&S.witchPoison){
          const id=this._seatId(S,j.poison,{exclude:witch.id});
          if(id!=null)poison=id;
        }
        return {save,poison};
      }catch(e){console.warn("LLM 用药回退:",e.message);}
    }
    return AI.witchAct(S,witch);
  }

  /* 猎人开枪 → 目标 id 或 null(放弃) */
  async hunterTarget(S,hunter){
    if(LLM.ready()){
      try{
        const j=await this._ask(S,hunter,
          '你出局了(没有被毒杀),猎人的枪可以带走一名存活玩家,也可以放弃。输出 {"target":座位号} 或 {"target":null}。');
        if(j.target==null)return null;
        const id=this._seatId(S,j.target,{exclude:hunter.id});
        if(id!=null)return id;
      }catch(e){console.warn("LLM 开枪回退:",e.message);}
    }
    const t=AI.topSusp(S,hunter);
    return t?t.id:null;
  }
}
