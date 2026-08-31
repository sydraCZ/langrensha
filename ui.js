"use strict";
/* ============================================================
   ui.js —— 视图层:渲染与交互,实现 engine 依赖的 view 接口
   不包含任何游戏规则逻辑
   ============================================================ */

const el={
  indicator:document.getElementById("dayIndicator"),
  square:document.getElementById("tableSquare"),
  title:document.getElementById("phaseTitle"),
  sub:document.getElementById("phaseSub"),
  logList:document.getElementById("logList"),
  actionBar:document.getElementById("actionBar"),
  overlayRoot:document.getElementById("overlayRoot"),
};

/* 圆桌座位定位:1 号位在正下方,顺时针排列 */
const POS=Array.from({length:9},(_,i)=>{
  const a=Math.PI/2+i*(2*Math.PI/9);
  return {x:50+39.5*Math.cos(a),y:50+39.5*Math.sin(a)};
});

/* ---------- 玩家昵称配置(纯 UI 展示,可随意增删改名) ----------
   游戏逻辑、对局记录与 LLM 提示词只使用座位号,完全不读取本数组;
   这里的人名仅用于座位牌和终局名单的显示。
   按座位顺序分配给 8 名 AI(跳过人类所在的座位)。 */
const SEAT_NICKS=["老猎户","王寡妇","教书先生","张屠户","陈货郎","李铁匠","阿花","三叔公"];

/* snapshot.players 恒按座位号升序 → 跳过人类座位,依次取昵称 */
function seatNickMap(snap){
  const m={};let ai=0;
  for(const p of (snap&&snap.players)||[]){
    m[p.id]=p.isHuman?"你":(SEAT_NICKS[ai++]||"村民");
  }
  return m;
}

/* ---------- 通用模态 ---------- */

function openModal(build){
  return new Promise(resolve=>{
    const ov=document.createElement("div");
    ov.className="overlay";
    const m=document.createElement("div");
    m.className="modal";
    build(m,value=>{ov.remove();resolve(value);});
    ov.appendChild(m);
    el.overlayRoot.appendChild(ov);
  });
}

/* ---------- view 接口 ---------- */

const view={
  _snap:null,
  _picking:null,
  fast:false,

  log(text,cls){
    const item=document.createElement("div");
    item.className="log-item "+(cls||"sys");
    item.textContent=text;
    el.logList.appendChild(item);
    el.logList.scrollTop=el.logList.scrollHeight;
  },

  clearLog(){
    el.logList.innerHTML="";
  },

  setStage(title,sub,isNight){
    el.title.textContent=title;
    el.sub.textContent=sub||"";
    el.square.classList.toggle("day",!isNight);
    el.square.classList.toggle("night",!!isNight);
    el.title.style.animation="none";
    void el.title.offsetHeight;
    el.title.style.animation="";
  },

  setIndicator(text){
    el.indicator.textContent=text;
  },

  /* snapshot: {players:[{id,alive,isHuman,roleText,roleClass,votes,justDied}]} */
  render(snap){
    this._snap=snap;
    this._redraw();
  },

  _redraw(){
    el.square.querySelectorAll(".seat").forEach(n=>n.remove());
    if(!this._snap)return;
    const nick=seatNickMap(this._snap);
    for(const p of this._snap.players){
      const b=document.createElement("button");
      b.type="button";
      b.className="seat";
      b.style.left=POS[p.id].x+"%";
      b.style.top=POS[p.id].y+"%";
      if(!p.alive)b.classList.add("dead");
      if(p.justDied)b.classList.add("just-died");
      if(this._picking&&this._picking.valid.has(p.id)&&p.alive){
        b.classList.add("clickable");
        b.addEventListener("click",()=>{
          if(!this._picking||!this._picking.valid.has(p.id)||!p.alive)return;
          const res=this._picking.res;
          this._picking=null;
          this._redraw();
          res(p.id);
        });
      }
      const num=document.createElement("div");
      num.className="seat-num";num.textContent=String(p.id+1);
      const nm=document.createElement("div");
      nm.className="seat-name";nm.textContent=nick[p.id];
      b.append(num,nm);
      if(p.roleText){
        const r=document.createElement("div");
        r.className="seat-role "+(p.roleClass||"");
        r.textContent=p.roleText;
        b.appendChild(r);
      }
      if(p.votes>0){
        const v=document.createElement("div");
        v.className="vote-badge";v.textContent=p.votes+"票";
        b.appendChild(v);
      }
      b.disabled=!p.alive;
      el.square.appendChild(b);
    }
  },

  pickSeat(validIds,prompt){
    return new Promise(res=>{
      this._picking={valid:new Set(validIds),res};
      this.setActions([],prompt+"(点击座位)");
      this._redraw();
    });
  },

  confirm(text,okLabel,cancelLabel){
    return openModal((m,close)=>{
      const p=document.createElement("p");
      p.className="role-desc";p.textContent=text;
      const row=document.createElement("div");
      row.className="btn-row";
      const ok=document.createElement("button");
      ok.type="button";ok.className="btn primary";ok.textContent=okLabel;
      ok.addEventListener("click",()=>close(true));
      const cancel=document.createElement("button");
      cancel.type="button";cancel.className="btn";cancel.textContent=cancelLabel;
      cancel.addEventListener("click",()=>close(false));
      row.append(ok,cancel);m.append(p,row);
    });
  },

  choice(text,options){
    return openModal((m,close)=>{
      const p=document.createElement("p");
      p.className="role-desc";p.textContent=text;
      const row=document.createElement("div");
      row.className="btn-row";
      options.forEach((opt,i)=>{
        const b=document.createElement("button");
        b.type="button";
        b.className="btn "+(i===0?"primary":"");
        b.textContent=opt;
        b.addEventListener("click",()=>close(i));
        row.appendChild(b);
      });
      m.append(p,row);
    });
  },

  /* options: [{key,label,cls?,...payload}],返回被点的 option 或 {key:'text',text} */
  askSpeech(options,hint){
    return new Promise(res=>{
      this.setActions(options,hint);
      for(const b of el.actionBar.querySelectorAll("button.btn[data-key]")){
        b.addEventListener("click",()=>{
          const opt=options.find(o=>String(o.key)===b.dataset.key);
          this.clearActions();
          res(opt);
        });
      }
      const input=document.createElement("input");
      input.type="text";input.className="text-input";
      input.placeholder="或者,自由说两句……";
      const send=document.createElement("button");
      send.type="button";send.className="btn";send.textContent="发言";
      send.addEventListener("click",()=>{
        const v=input.value.trim();
        if(!v)return;
        this.clearActions();
        res({key:"text",text:v});
      });
      input.addEventListener("keydown",e=>{
        if(e.key==="Enter"&&input.value.trim()){
          this.clearActions();
          res({key:"text",text:input.value.trim()});
        }
      });
      el.actionBar.append(input,send);
      input.focus();
    });
  },

  setActions(list,hint){
    el.actionBar.innerHTML="";
    if(hint){
      const h=document.createElement("span");
      h.className="action-hint";h.textContent=hint;
      el.actionBar.appendChild(h);
    }
    for(const a of list){
      const b=document.createElement("button");
      b.type="button";
      b.className="btn "+(a.cls||"");
      b.dataset.key=String(a.key||"");
      b.textContent=a.label;
      if(a.onClick)b.addEventListener("click",a.onClick);
      el.actionBar.appendChild(b);
    }
  },

  clearActions(){
    el.actionBar.innerHTML="";
  },

  /* data: {roleName, roleClass, desc, matesText|null} */
  openRoleModal(data){
    return openModal((m,close)=>{
      const h=document.createElement("h2");
      h.textContent="你的身份";
      const rn=document.createElement("div");
      rn.className="role-name "+data.roleClass;
      rn.textContent=data.roleName;
      const d=document.createElement("p");
      d.className="role-desc";d.textContent=data.desc;
      m.append(h,rn,d);
      if(data.matesText){
        const mate=document.createElement("p");
        mate.className="role-mates";mate.textContent=data.matesText;
        m.appendChild(mate);
      }
      const row=document.createElement("div");
      row.className="btn-row";
      const start=document.createElement("button");
      start.type="button";start.className="btn primary";start.textContent="天黑请闭眼";
      start.addEventListener("click",()=>close());
      row.appendChild(start);m.appendChild(row);
    });
  },

  /* data: {goodWin, story, revealList:[{id,alive,role,cls}]} → 'again' | 'stay' */
  openEndModal(data){
    return openModal((m,close)=>{
      const h=document.createElement("h2");
      h.textContent=data.goodWin?"好人胜利":"狼人胜利";
      h.style.color=data.goodWin?"var(--gold)":"var(--blood)";
      const line=document.createElement("p");
      line.className="win-line";line.textContent=data.story;
      const grid=document.createElement("div");
      grid.className="reveal-grid";
      const nick=seatNickMap(this._snap);
      for(const rv of data.revealList){
        const d=document.createElement("div");
        d.className="rv "+(rv.cls||"");
        const who=document.createElement("span");
        who.textContent=nick[rv.id]+(rv.alive?"":"(出局)");
        const role=document.createElement("span");role.textContent=rv.role;
        d.append(who,role);
        grid.appendChild(d);
      }
      const row=document.createElement("div");
      row.className="btn-row";
      const again=document.createElement("button");
      again.type="button";again.className="btn primary";again.textContent="再来一局";
      again.addEventListener("click",()=>close("again"));
      const stay=document.createElement("button");
      stay.type="button";stay.className="btn";stay.textContent="查看战局";
      stay.addEventListener("click",()=>close("stay"));
      row.append(again,stay);
      m.append(h,line,grid,row);
    });
  },

  openRulesModal(){
    return openModal((m,close)=>{
      const h=document.createElement("h2");h.textContent="对局规则";
      const body=document.createElement("div");
      body.className="rules-body";
      body.innerHTML=
        "<p><b>配置</b> 九人标准局:<span class='r-wolf'>狼人 ×3</span> · 村民 ×3 · 预言家 · 女巫 · 猎人。身份随机发放。</p>"+
        "<p><b>夜晚</b> 狼人袭击 → 预言家查验 → 女巫决定是否用药。解药、毒药各限一次,<b>女巫不能自救</b>。</p>"+
        "<p><b>白天</b> 公布死讯 → 按座位号轮流发言 → 投票放逐,得票最多者出局;<b>平票则无人出局</b>。</p>"+
        "<p><b>猎人</b> 被袭击或被放逐时可开枪带走一人;<b>被毒杀则不能开枪</b>。</p>"+
        "<p><b>胜负</b> 狼人全部出局,好人胜;狼人数<b>不少于</b>好人数,狼人胜。</p>"+
        "<p>你出局后自动进入上帝视角,可以看到所有身份。</p>";
      const row=document.createElement("div");
      row.className="btn-row";
      const ok=document.createElement("button");
      ok.type="button";ok.className="btn";ok.textContent="知道了";
      ok.addEventListener("click",()=>close());
      row.appendChild(ok);m.append(h,body,row);
    });
  },

  /* LLM 接入设置:OpenAI 兼容端点(接口地址 / API Key / 模型名) */
  openSettingsModal(){
    return openModal((m,close)=>{
      const h=document.createElement("h2");h.textContent="AI 设置";
      const body=document.createElement("div");
      body.className="rules-body";
      body.innerHTML=
        "<p>配置任意 <b>OpenAI 兼容接口</b>后,8 名 AI 玩家将改由大模型驱动:它们记得本局每天的死亡、发言与投票,自己推理、撒谎、站队、投票。不配置则使用内置规则 AI。</p>"+
        "<p>兼容 DeepSeek、通义千问、Kimi、智谱、Ollama 等。密钥只保存在本浏览器(localStorage),不会上传到别处。</p>";

      const fields=[["baseUrl","接口地址","https://api.deepseek.com/v1"],
        ["apiKey","API Key","sk-…"],["model","模型名","deepseek-chat"]];
      const inputs={};
      const cur=LLM.config||{};
      for(const [key,label,ph]of fields){
        const wrap=document.createElement("p");
        wrap.style.margin="10px 0 4px";
        const lab=document.createElement("div");
        lab.className="action-hint";lab.textContent=label;
        const input=document.createElement("input");
        input.type=key==="apiKey"?"password":"text";
        input.className="text-input";
        input.style.width="100%";
        input.placeholder=ph;
        input.value=cur[key]||"";
        wrap.append(lab,input);
        body.appendChild(wrap);
        inputs[key]=input;
      }
      const status=document.createElement("p");
      status.className="action-hint";
      status.style.minHeight="18px";
      status.textContent=LLM.ready()?"已配置,当前生效模型:"+LLM.config.model:"";
      body.appendChild(status);

      const row=document.createElement("div");
      row.className="btn-row";
      const mk=(text,cls,fn)=>{
        const b=document.createElement("button");
        b.type="button";b.className="btn "+(cls||"");
        b.textContent=text;
        b.addEventListener("click",fn);
        row.appendChild(b);
      };
      mk("测试连接","",async btn=>{
        status.textContent="测试中……";
        LLM.config={baseUrl:inputs.baseUrl.value.trim(),
          apiKey:inputs.apiKey.value.trim(),model:inputs.model.value.trim()};
        try{
          await LLM.chat("你是一个连通性测试。","请只回复:OK",{maxTokens:10,timeout:15000});
          status.textContent="连接成功 ✓";
        }catch(e){
          status.textContent="连接失败:"+e.message;
          LLM.load();
        }
      });
      mk("保存","primary",()=>{
        const cfg={baseUrl:inputs.baseUrl.value.trim(),
          apiKey:inputs.apiKey.value.trim(),model:inputs.model.value.trim()};
        if(cfg.baseUrl&&cfg.apiKey&&cfg.model){
          LLM.save(cfg);
          close();
        }else{
          status.textContent="三项都要填写才能保存。";
        }
      });
      mk("清除","",()=>{
        LLM.clear();
        status.textContent="已清除,恢复内置规则 AI。";
        for(const k in inputs)inputs[k].value="";
      });
      mk("关闭","",()=>{LLM.load();close();});
      m.append(h,body,row);
    });
  },

  sleep(ms){
    return new Promise(r=>setTimeout(r,this.fast?Math.min(ms,70):ms));
  },
};

/* ---------- 顶栏按钮 ---------- */

document.getElementById("speedBtn").addEventListener("click",e=>{
  view.fast=!view.fast;
  e.target.textContent=view.fast?"常速":"加速";
});
document.getElementById("rulesBtn").addEventListener("click",()=>view.openRulesModal());
document.getElementById("llmBtn").addEventListener("click",()=>view.openSettingsModal());
