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
  return p.human?`${p.id+1}号(人类玩家)`:`${p.id+1}号 ${p.name}`;
}

function llmTranscript(S){
  if(!S.transcript||!S.transcript.length)return "(对局刚开始,还没有公开事件)";
  const byDay=new Map();
  for(const e of S.transcript){
    if(!byDay.has(e.day))byDay.set(e.day,[]);
    byDay.get(e.day).push(e.text);
  }
  return [...byDay.entries()]
    .map(([d,lines])=>`【第${d}天】\n`+lines.map(l=>"- "+l).join("\n"))
    .join("\n");
}

function llmSystem(S,p){
  let priv="";
  if(p.role===WOLF){
    const mates=S.players.filter(q=>q.role===WOLF&&q.id!==p.id);
    priv="你的狼队友:"+mates.map(q=>`${q.id+1}号${q.human?"(人类玩家)":" "+q.name}${q.alive?"(存活)":"(已出局)"}`).join("、")
      +"。狼人夜里共同决定袭击目标,白天必须隐藏身份、伪装好人。\n";
  }else if(p.role===SEER){
    const ks=Object.keys(p.checks);
    priv=ks.length
      ?"你的查验记录:"+ks.map(t=>`${+t+1}号=${p.checks[t]==="wolf"?"狼人":"好人"}`).join("、")+"\n"
      :"你还没有查验过任何人。\n";
  }else if(p.role===WITCH){
    priv=`你的解药${S.witchHeal?"未使用(可用)":"已用完"},毒药${S.witchPoison?"未使用(可用)":"已用完"}。解药不能救自己。\n`;
  }
  const seats=S.players
    .map(q=>`${q.id+1}号${q.human?"(人类玩家)":" "+q.name}${q.alive?"(存活)":"(出局)"}`)
    .join("、");
  return "你在玩一局狼人杀(9人标准局:3狼人、3村民、预言家、女巫、猎人)。\n"
    +`你扮演 ${llmSeatName(p)},身份是【${ROLE_NAME[p.role]}】。\n${priv}`
    +`座位表:${seats}\n`
    +"规则:白天按座位号轮流发言后投票放逐,得票最多者出局,平票无人出局;夜里狼人袭击、预言家查验、女巫可用药。猎人被袭击或被放逐时可开枪带走一人,被毒杀则不能开枪。狼人全部出局则好人胜;狼人数不少于好人数则狼人胜。\n"
    +"要求:完全代入角色,像真人一样只依据对局记录与你的私有信息推理、发言、投票——狼人要伪装撒谎,好人要找狼。你的回答必须是合法 JSON,除 JSON 外不要输出任何内容。";
}

function llmUser(S,task){
  return `===对局记录===\n${llmTranscript(S)}\n\n===当前任务===\n${task}`;
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
    return LLM.chatJSON(llmSystem(S,p),llmUser(S,task),opts);
  }

  /* 发言 → {line, claim:{target,result}|null, wolfJump:boolean} */
  async speech(S,p,ctx){
    if(LLM.ready()){
      try{
        const j=await this._ask(S,p,
          "现在轮到你发言。结合对局记录(包括今天在你之前每个人的发言)给出你的发言,中文口语,像真人,1~3句。"
          +'输出 {"line":"你的发言","claim":null};只有当你想跳预言家(真跳或悍跳)时才把 claim 填成 {"target":座位号,"result":"sha"或"water"},其余情况必须是 null。');
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
          '现在全场投票放逐。选出你认为最该出局的人(不能投自己,必须是存活玩家)。输出 {"target":座位号}。');
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
          '天黑了,狼人行动。你们要选择今晚袭击谁(不能袭击狼队友,必须是存活的好人阵营玩家)。输出 {"target":座位号}。');
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
          ?`今晚 ${S.knifeTarget+1}号 被狼人袭击`
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
