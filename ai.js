"use strict";
/* ============================================================
   ai.js —— AI 决策层 + 发言生成(SpeechProvider)
   纯逻辑,不碰 DOM;所有方法以游戏状态 S 为第一参数
   ============================================================ */

/* ---------- 共享常量与工具 ---------- */

const WOLF="wolf",VILLAGER="villager",SEER="seer",WITCH="witch",HUNTER="hunter";
const ROLE_NAME={wolf:"狼人",villager:"村民",seer:"预言家",witch:"女巫",hunter:"猎人"};
const ROLE_DESC={
  wolf:"每晚与同伴袭击一名玩家。白天隐藏在人群里,把水搅浑,活到狼群不少于好人为止。",
  seer:"每晚查验一名玩家的阵营。白天可以跳出来报查杀,带领好人放逐狼人。",
  witch:"手中有一瓶解药、一瓶毒药,整局各限用一次。今晚倒下的人你可以救——但不能自救。",
  hunter:"被狼人袭击或被投票放逐时,可以开枪带走一人。但被毒杀时,枪响不了。",
};
const ROLE_CLASS={wolf:"wolf",seer:"god",witch:"god",hunter:"god",villager:"plain"};
const ROLE_TINT={wolf:"wolf",seer:"god",witch:"god",hunter:"god",villager:""};
const AI_NAMES=["老猎户","王寡妇","教书先生","张屠户","陈货郎","李铁匠","阿花","三叔公"];

function shuffle(arr){
  const a=arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
const pick=arr=>arr[Math.floor(Math.random()*arr.length)];

/* ---------- AI 决策 ---------- */

const AI={
  villageAIs(S){
    return S.players.filter(p=>!p.human&&p.role!==WOLF&&p.alive);
  },

  /* 跳预言家声明进入公共信息池,并更新好人 AI 的怀疑值 */
  applyClaim(S,claim){
    if(S.claims.some(c=>c.seer===claim.seer&&c.target===claim.target))return;
    S.claims.push(claim);
    for(const v of this.villageAIs(S)){
      if(claim.result==="sha")v.susp[claim.target]+=8;
      const claimants=S.claims.map(c=>c.seer);
      if(claimants.length>=2){
        for(const cid of claimants)if(cid!==v.id)v.susp[cid]+=5;
      }else if(claim.seer!==v.id){
        v.susp[claim.seer]-=3;
      }
    }
  },

  /* 狼人夜里选刀口:优先咬跳出来的(非狼)预言家 */
  wolfChoose(S){
    const cands=S.players.filter(p=>p.alive&&p.role!==WOLF);
    const claimants=S.claims
      .map(c=>c.seer)
      .filter(id=>S.players[id].alive&&S.players[id].role!==WOLF);
    if(claimants.length&&Math.random()<0.8)return pick(claimants);
    return pick(cands).id;
  },

  seerCheck(S,seer){
    const cands=S.players.filter(p=>p.alive&&p.id!==seer.id&&!(p.id in seer.checks));
    if(!cands.length)return;
    let best=null,bestScore=-Infinity;
    for(const c of cands){
      const score=seer.susp[c.id]+Math.random()*2;
      if(score>bestScore){bestScore=score;best=c;}
    }
    seer.checks[best.id]=best.role===WOLF?"wolf":"good";
  },

  witch(S,witch){
    const t=S.knifeTarget;
    if(S.witchHeal&&t!=null&&t!==witch.id){
      const isClaimant=S.claims.some(c=>c.seer===t);
      const pSave=S.day===1?0.85:(isClaimant?0.65:0.22);
      if(Math.random()<pSave){S.saved=true;S.witchHeal=false;}
    }
    if(S.witchPoison&&S.day>=2){
      let best=null,bestScore=0;
      for(const p of S.players){
        if(!p.alive)continue;
        if(p.id===witch.id||p.id===t&&S.saved)continue;
        if(witch.susp[p.id]>bestScore){bestScore=witch.susp[p.id];best=p;}
      }
      if(best&&bestScore>=7&&Math.random()<0.55){
        S.poisonTarget=best.id;S.witchPoison=false;
      }
    }
  },

  /* 怀疑值最高的存活玩家(排除自己) */
  topSusp(S,ai){
    let best=null,bestScore=-Infinity;
    for(const p of S.players){
      if(!p.alive||p.id===ai.id)continue;
      const score=ai.susp[p.id]+Math.random();
      if(score>bestScore){bestScore=score;best=p;}
    }
    return best;
  },

  avgSusp(S,id){
    const vs=this.villageAIs(S);
    if(!vs.length)return 0;
    return vs.reduce((s,v)=>s+v.susp[id],0)/vs.length;
  },

  vote(S,p){
    const others=S.players.filter(q=>q.alive&&q.id!==p.id);
    if(!others.length)return null;
    if(p.role===WOLF){
      const nonWolf=others.filter(q=>q.role!==WOLF);
      if(!nonWolf.length)return pick(others).id;
      const myClaim=S.claims.find(c=>c.seer===p.id);
      if(myClaim&&S.players[myClaim.target].alive&&S.players[myClaim.target].role!==WOLF)
        return myClaim.target;
      let best=null,bestScore=-Infinity;
      for(const q of nonWolf){
        const score=this.avgSusp(S,q.id)+Math.random();
        if(score>bestScore){bestScore=score;best=q;}
      }
      return best?best.id:pick(nonWolf).id;
    }
    if(p.role===SEER){
      const knownWolf=others.find(q=>p.checks[q.id]==="wolf");
      if(knownWolf)return knownWolf.id;
    }
    const t=this.topSusp(S,p);
    return t?t.id:pick(others).id;
  },

  /* 发言决策:返回意图(带副作用——报查杀会写入 claims,悍跳会置位)
     intent 类型: claim / counterClaim / pickBetween / follow / accuse / generic */
  decide(S,p){
    const alive=id=>S.players[id].alive;
    const shaClaims=S.claims.filter(c=>c.result==="sha"&&alive(c.target));
    const claimants=[...new Set(S.claims.map(c=>c.seer))].filter(alive);

    if(p.role===SEER){
      const entries=Object.entries(p.checks);
      if(entries.length){
        const [tid,res]=entries[entries.length-1];
        const result=res==="wolf"?"sha":"water";
        this.applyClaim(S,{seer:p.id,target:+tid,result,fake:false});
        return {type:"claim",target:+tid,result};
      }
    }
    if(p.role===WOLF&&!S.wolfJumped){
      const exposed=S.claims.find(c=>c.target===p.id&&c.result==="sha"&&!c.fake);
      if(exposed){
        S.wolfJumped=true;
        this.applyClaim(S,{seer:p.id,target:exposed.seer,result:"sha",fake:true});
        return {type:"counterClaim",target:exposed.seer};
      }
    }
    if(claimants.length>=2){
      const a=claimants[0],b=claimants[1];
      const doubt=p.susp[a]>=p.susp[b]?a:b;
      return {type:"pickBetween",a,b,doubt};
    }
    if(shaClaims.length&&p.role!==WOLF){
      const c=shaClaims[shaClaims.length-1];
      return {type:"follow",seer:c.seer,target:c.target};
    }
    // 只点评已经发过言的人:没开口的人谈不上"发言有问题"
    const spoken=[...S.spokenToday].filter(id=>id!==p.id&&alive(id));
    if(spoken.length&&Math.random()<0.7){
      let pool=spoken;
      if(p.role===WOLF){
        pool=spoken.filter(id=>S.players[id].role!==WOLF);
      }
      if(pool.length){
        let best=null,bestScore=-Infinity;
        for(const id of pool){
          const score=(p.role===WOLF?this.avgSusp(S,id):p.susp[id])+Math.random();
          if(score>bestScore){bestScore=score;best=id;}
        }
        return {type:"accuse",target:best};
      }
    }
    return {type:"generic"};
  },
};

/* ============================================================
   SpeechProvider 接口:generate(player, intent, ctx) → Promise<string>
   ctx: {nameOf(id)→string} —— 引擎注入的名字函数
   将来接入 LLM 时新增实现类即可,engine 无感切换
   ============================================================ */

class TemplateSpeech{
  async generate(p,intent,ctx){
    const n=ctx.nameOf;
    switch(intent.type){
      case "claim":
        return intent.result==="sha"
          ?`我是预言家!昨晚验了${n(intent.target)},是查杀!今天全票把他送走。`
          :`我是预言家,昨晚验了${n(intent.target)},金水。他可以放一放,查杀另找。`;
      case "counterClaim":
        return `我不是狼!我才是预言家,昨晚验了${n(intent.target)},查杀!他血口喷人,想泼脏水害我。`;
      case "pickBetween":
        return `两个"预言家"必有一个是狼。${n(intent.a)}和${n(intent.b)}我更不信${n(intent.doubt)},先出他。`;
      case "follow":
        return `听预言家的,${n(intent.seer)}报了查杀,我这一票给${n(intent.target)}。`;
      case "accuse":
        return p.role===WOLF
          ?`我平民一个,昨晚睡得很沉。倒觉得${n(intent.target)}的发言最经不起推敲,票给他。`
          :`我觉得${n(intent.target)}有点悬,发言总往边上绕,先记他一笔。`;
      default:
        return pick([
          "我是个好人,昨晚过得平平常常,先听大家的。",
          "信息还太少,我不想乱踩人,先听听后面怎么说。",
          "我是好人,今天节奏别太快,把发言听全了再投。",
          "昨晚的事我不清楚,但我的票不会乱投,谁心虚我投谁。",
        ]);
    }
  }
}
