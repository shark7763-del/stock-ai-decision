/* ===================================================================
   AI Trade Coach Pro — 專業版升級模組 pro.js
   於 app.js 之後載入；以「附加 / 覆寫」方式擴充，不破壞既有核心。
   內容：
     一、真實資料來源架構（TWSE / TPEx / FinMind 預留接口）
     二、大盤四燈號濾網（綠/黃/橘/紅，紅燈強制禁止新倉）
     三、AI 進場分數 100 分制（技術25 籌碼20 基本15 題材15 大盤15 風報10）
     四、AI 逃命指數 100 分制（七因子）
     五、停損與部位計算（支援絕對停損價）
     六、策略回測中心
     七、AI 教練十項完整報告
     八、交易復盤（結構化檢核）
     九、手機今日速報
   =================================================================== */
'use strict';

/* ===================================================================
   一、真實資料來源架構（API 接口預留）
   目前前端為純靜態，正式串接時請改由「後端 / GitHub Actions」抓取，
   寫入 data.json 後前端讀取（避免瀏覽器 CORS）。以下為標準接口定義。
   =================================================================== */
const DATA_SOURCES = {
  TWSE: { // 證交所 上市 OpenAPI  https://openapi.twse.com.tw
    base: 'https://openapi.twse.com.tw/v1',
    daily:   '/exchangeReport/STOCK_DAY_ALL',          // 每日收盤行情(開高低收量)
    inst:    '/fund/T86',                               // 三大法人買賣超
    margin:  '/exchangeReport/MI_MARGN',               // 融資融券
    per:     '/exchangeReport/BWIBBU_ALL',             // 本益比/殖利率/股價淨值比
    revenue: '/opendata/t187ap05_L',                   // 月營收
    eps:     '/opendata/t187ap14_L'                    // 財報每股盈餘 EPS
  },
  TPEX: { // 櫃買中心 上櫃 OpenAPI  https://www.tpex.org.tw/openapi
    base: 'https://www.tpex.org.tw/openapi/v1',
    daily:   '/tpex_mainboard_daily_close_quotes',
    inst:    '/tpex_3insti_daily_trading',
    margin:  '/tpex_margin_balance',
    per:     '/tpex_mainboard_peratio_analysis',
    revenue: '/tpex_mopsfin_t187ap05_O'
  },
  FINMIND: { // FinMind  https://finmindtrade.com  （需 token，免費版有額度）
    base: 'https://api.finmindtrade.com/api/v4/data',
    token: '',  // ← 申請後填入；空字串代表停用，改用 TWSE/TPEx
    datasets: {
      price:   'TaiwanStockPrice',
      inst:    'TaiwanStockInstitutionalInvestorsBuySell',
      margin:  'TaiwanStockMarginPurchaseShortSale',
      per:     'TaiwanStockPER',
      revenue: 'TaiwanStockMonthRevenue',
      eps:     'TaiwanStockFinancialStatements',
      news:    'TaiwanStockNews'
    }
  }
};
/* 統一的資料欄位（前端內部格式）— 抓取端請對應補齊 */
const STOCK_SCHEMA = ['code','name','industry','open','high','low','price','chg','volume','vol5',
  'ma5','ma10','ma20','ma60','rsi','k','d','macd','foreign','trust','margin',
  'eps','pe','revYoY','revMoM','newsSenti','socialHeat','history'];

/* 接口（前端示範用，正式請走後端）。回傳 Promise，目前讀本地 data.json。 */
async function apiFetchDaily(source='TWSE'){
  // 正式：fetch(`${DATA_SOURCES[source].base}${DATA_SOURCES[source].daily}`)
  // 示範：仍由 data.json 提供（GitHub Actions 產生）
  try{ const r=await fetch('data.json?t='+Date.now()); return r.ok?await r.json():null; }catch(e){ return null; }
}
async function apiFetchFinMind(dataset, params={}){
  const c=DATA_SOURCES.FINMIND; if(!c.token) return {note:'未設定 FinMind token，停用'};
  const url=`${c.base}?dataset=${dataset}&token=${c.token}&${new URLSearchParams(params)}`;
  try{ const r=await fetch(url); return await r.json(); }catch(e){ return {error:String(e)}; }
}

/* ===================================================================
   二、大盤四燈號濾網
   依大盤風險指數（marketInfo().risk）分四級；紅燈 force=true → 強制禁止新倉
   =================================================================== */
function marketLight(){
  const mk=(typeof marketInfo==='function')?marketInfo():{has:false,risk:0,trend:0,state:'未設定'};
  if(!mk.has) return {key:'gray',label:'未設定',action:'請先設定大盤數據',css:'',force:false,risk:mk.risk,trend:mk.trend,note:'尚未設定加權／櫃買指數，無法判斷大盤環境。'};
  const r=n(mk.risk);
  if(r<=35) return {key:'green', label:'🟢 綠燈',action:'可正常進場',     css:'go',   force:false,risk:r,trend:mk.trend,note:'大盤多方、風險低，可依個股訊號正常布局。'};
  if(r<=55) return {key:'yellow',label:'🟡 黃燈',action:'小部位觀察',     css:'watch',force:false,risk:r,trend:mk.trend,note:'大盤中性，建議降低單筆部位、嚴選高分標的。'};
  if(r<=70) return {key:'orange',label:'🟠 橘燈',action:'只觀察不追高',   css:'watch',force:false,risk:r,trend:mk.trend,note:'大盤轉弱，只做 A 區低接、嚴禁追高，控管總部位。'};
  return            {key:'red',   label:'🔴 紅燈',action:'禁止新倉',       css:'stop', force:true, risk:r,trend:mk.trend,note:'大盤高風險，系統強制禁止所有新倉（保護機制），優先檢查持股風險。'};
}

/* 覆寫 forbidEntry：保留原規則並加入「大盤紅燈強制禁止」 */
function forbidEntry(s){
  const reasons=[];
  const ml=marketLight();
  if(ml.force) reasons.push(`大盤${ml.label}：禁止新倉（保護機制）`);
  const price=n(s.price), ma20=n(s.ma20);
  const bias=ma20?((price-ma20)/ma20)*100:0;
  const tp=targetPrices(s);
  const stopPrice=price*(1-0.08), lossPerShare=price-stopPrice;
  const rr=(lossPerShare>0)?(tp.t1-price)/lossPerShare:0;
  const top=topIndex(s).score;
  const mk=marketInfo();
  const cap=n(cfg.capital)||0, oneLotRisk=lossPerShare*1000;
  if(rr>0 && rr<1.5) reasons.push(`風險報酬比 ${rr.toFixed(2)} < 1 : 1.5`);
  if(bias>8) reasons.push(`正乖離 20MA ${bias.toFixed(1)}% > 8%（追高風險）`);
  if(top>70) reasons.push(`逃命指數 ${top} > 70`);
  if(cap && oneLotRisk>cap*0.02) reasons.push(`單筆風險(最小1張) 超過總資金 2%`);
  if(mk.has && mk.risk>70 && !ml.force) reasons.push(`大盤風險指數 ${mk.risk} > 70`);
  return reasons;
}

/* ===================================================================
   三、AI 進場分數 100 分制
   技術面 25 / 籌碼面 20 / 基本面 15 / 題材熱度 15 / 大盤環境 15 / 風險報酬比 10
   =================================================================== */
function fundamentalScore(s){
  // 基本面：月營收年增、EPS、本益比。無資料→中性偏低並標記。
  const eps=n(s.eps), pe=n(s.pe), yoy=n(s.revYoY);
  const has = (s.eps!=null&&s.eps!=='')||(s.pe!=null&&s.pe!=='')||(s.revYoY!=null&&s.revYoY!=='');
  if(!has) return {pts:7, has:false, detail:'基本面資料不足（EPS／本益比／營收未提供），以中性計分。'};
  let p=0; const d=[];
  if(yoy>=20){p+=6;d.push(`月營收年增 ${yoy}%（強勁）`);} else if(yoy>=0){p+=3;d.push(`月營收年增 ${yoy}%`);} else if(yoy<0){d.push(`月營收年減 ${yoy}%`);}
  if(eps>=5){p+=5;d.push(`EPS ${eps}（獲利佳）`);} else if(eps>0){p+=3;d.push(`EPS ${eps}`);} else if(eps<0){d.push(`EPS ${eps}（虧損）`);}
  if(pe>0&&pe<=20){p+=4;d.push(`本益比 ${pe}（評價合理）`);} else if(pe>20&&pe<=35){p+=2;d.push(`本益比 ${pe}（偏高）`);} else if(pe>35){d.push(`本益比 ${pe}（過高）`);}
  return {pts:clamp(p,0,15), has:true, detail:d.join('、')||'基本面普通'};
}
function entryScore100(s){
  const a=analyze(s);
  const price=n(s.price),ma5=n(s.ma5),ma10=n(s.ma10),ma20=n(s.ma20),ma60=n(s.ma60),rsi=n(s.rsi),k=n(s.k),d=n(s.d);
  const vr=n(s.vol5)?n(s.volume)/n(s.vol5):1, bias=ma20?((price-ma20)/ma20)*100:0;
  // 技術面 25
  let tech=0;
  if(price>ma20)tech+=6; if(ma20>ma60)tech+=5; if(ma5>ma10&&ma10>ma20)tech+=4;
  if(k>d&&k<80)tech+=4; if(rsi>=50&&rsi<=70)tech+=3; if(vr>1)tech+=3; tech=clamp(tech,0,25);
  // 籌碼面 20（沿用 analyze.chips 0~100）
  const chip=clamp(a.chips/100*20,0,20);
  // 基本面 15
  const fund=fundamentalScore(s);
  // 題材熱度 15（新聞題材 + 社群熱度）
  const news=analyzeNewsSentiment(s), social=analyzeSocialSentiment(s);
  const theme=clamp((news.theme*0.6+social.heat*0.4)/100*15,0,15);
  // 大盤環境 15
  const ml=marketLight();
  const mkt = ml.key==='green'?15:ml.key==='yellow'?10:ml.key==='orange'?5:ml.key==='gray'?7:0;
  // 風險報酬比 10
  const tp=targetPrices(s), stop=a.stop||price*0.92, lps=price-stop;
  const rr=lps>0?(tp.t1-price)/lps:0;
  const rrPts=rr>=3?10:rr>=2?8:rr>=1.5?5:rr>=1?3:0;
  const total=clamp(tech+chip+fund.pts+theme+mkt+rrPts,0,100);
  // 五級判語
  const escape=escapeScore100(s).total;
  let verdict,vcls;
  if(escape>=80||(stop>0&&price<=stop)){verdict='停損警示';vcls='stop';}
  else if(ml.force){verdict='禁止追高';vcls='stop';}
  else if(forbidEntry(s).length){verdict='禁止追高';vcls='stop';}
  else if(bias>8){verdict='等拉回';vcls='watch';}
  else if(total>=75&&rr>=2){verdict='可進場';vcls='go';}
  else if(total>=55){verdict='觀察';vcls='watch';}
  else {verdict='等拉回';vcls='watch';}
  return {total,verdict,vcls,rr:+rr.toFixed(2),escape,bias:+bias.toFixed(1),stop:+stop.toFixed(2),t1:+tp.t1.toFixed(2),t2:+tp.t2.toFixed(2),
    parts:[
      {k:'技術面',v:Math.round(tech),max:25,d:'均線排列／KD／RSI／量能'},
      {k:'籌碼面',v:Math.round(chip),max:20,d:'外資投信買賣超、融資結構'},
      {k:'基本面',v:Math.round(fund.pts),max:15,d:fund.detail},
      {k:'題材熱度',v:Math.round(theme),max:15,d:'新聞題材強度＋社群討論熱度'},
      {k:'大盤環境',v:mkt,max:15,d:`${ml.label}・${ml.action}`},
      {k:'風險報酬比',v:rrPts,max:10,d:`RR ${rr.toFixed(2)}（停損 ${stop.toFixed(2)} / 目標 ${tp.t1.toFixed(2)}）`}
    ], fund};
}

/* ===================================================================
   四、AI 逃命指數 100 分制（七因子）
   跌破5MA / 跌破20MA / 爆量長黑 / 外資轉賣 / RSI過熱轉弱 / 新聞負面 / 大盤轉弱
   =================================================================== */
function escapeScore100(s){
  const price=n(s.price),ma5=n(s.ma5),ma20=n(s.ma20),rsi=n(s.rsi),k=n(s.k),d=n(s.d),chg=n(s.chg),fo=n(s.foreign);
  const vr=n(s.vol5)?n(s.volume)/n(s.vol5):1;
  const news=analyzeNewsSentiment(s), ml=marketLight();
  const F=[];
  let sc=0;
  const add=(cond,p,label)=>{const on=!!cond; if(on)sc+=p; F.push({n:label,p:on?p:0,max:p,on});};
  add(price<ma5 && ma5>0, 15, '跌破 5 日線');
  add(price<ma20 && ma20>0, 20, '跌破 20 日線');
  add(vr>=1.5 && chg<=-2, 18, `爆量長黑（量 ${vr.toFixed(1)}x、跌 ${chg}%）`);
  add(fo<0, 15, '外資轉賣（買賣超為負）');
  add((rsi>=70 && (chg<0||k<d)) || rsi>=80, 12, `RSI 過熱轉弱（RSI ${rsi||'-'}）`);
  add(news.sentiment<=42, 10, `新聞面偏空（情緒 ${news.sentiment}）`);
  add(ml.key==='red'?true:false, 10, '大盤轉弱（紅燈）');
  if(ml.key==='orange'){sc+=5; F.push({n:'大盤偏弱（橘燈）',p:5,max:10,on:true});}
  sc=clamp(sc,0,100);
  let action,acls;
  if(sc>=85){action='強制停損';acls='stop';}
  else if(sc>=65){action='全部出場';acls='stop';}
  else if(sc>=45){action='減碼 1/2';acls='stop';}
  else if(sc>=25){action='減碼 1/3';acls='watch';}
  else {action='續抱';acls='go';}
  return {total:sc,action,acls,factors:F};
}

/* ===================================================================
   五、停損與部位計算（絕對停損價）
   =================================================================== */
function positionPlan({capital,riskPct,buy,stop,target}){
  capital=n(capital);riskPct=n(riskPct)||2;buy=n(buy);stop=n(stop);target=n(target);
  const lps=buy-stop;                          // 每股最大風險
  const stopPctV=buy?((buy-stop)/buy*100):0;
  const riskAmt=capital*riskPct/100;           // 可承受風險金額
  const lots=(lps>0)?Math.max(0,Math.floor(riskAmt/(lps*1000))):0;
  const maxLoss=lps*lots*1000;
  const cost=buy*lots*1000;
  const rr=(lps>0&&target>buy)?(target-buy)/lps:0;
  let worth,wcls,reason;
  if(lps<=0){worth='✘ 無效';wcls='stop';reason='停損價需低於買進價。';}
  else if(stopPctV>12){worth='✘ 不值得';wcls='stop';reason=`停損幅度 ${stopPctV.toFixed(1)}% 過寬（>12%），風險過大。`;}
  else if(!target){worth='⚠ 待補目標';wcls='watch';reason='請輸入目標價以評估風險報酬比。';}
  else if(rr>=2&&lots>=1){worth='✔ 值得進場';wcls='go';reason=`風報比 ${rr.toFixed(2)} ≥ 2，部位 ${lots} 張在風控內。`;}
  else if(rr>=1.5){worth='⚠ 勉強可';wcls='watch';reason=`風報比 ${rr.toFixed(2)} 介於 1.5~2，建議減量或等更好價位。`;}
  else {worth='✘ 不值得';wcls='stop';reason=`風報比 ${rr.toFixed(2)} < 1.5，期望值不足。`;}
  if(lots<1&&lps>0){worth='✘ 資金不足';wcls='stop';reason='依風控規則最大可買 0 張，請降低停損幅度或加大資金。';}
  return {lots,maxLoss,cost,rr:+rr.toFixed(2),lps:+lps.toFixed(2),stopPctV:+stopPctV.toFixed(1),riskAmt,worth,wcls,reason};
}

/* ===================================================================
   七、AI 教練十項完整報告
   =================================================================== */
function coachReport(s){
  const a=analyze(s), es=entryScore100(s), ex=escapeScore100(s);
  const news=analyzeNewsSentiment(s), social=analyzeSocialSentiment(s), pe=persona(s), ml=marketLight();
  const price=n(s.price),ma20=n(s.ma20),ma60=n(s.ma60),rsi=n(s.rsi);
  const bull=price>n(s.ma5)&&n(s.ma5)>n(s.ma10)&&n(s.ma10)>ma20&&ma20>ma60;
  const forb=forbidEntry(s);
  const t1=Math.max(a.t1, n(s.prevHigh)||a.t1);
  // 1 技術面
  const tech=`${bull?'均線多頭排列、':''}${price>ma20?'股價站上 20MA':'股價在 20MA 之下'}；RSI ${rsi||'-'}、KD ${n(s.k)}/${n(s.d)}，趨勢分 ${a.trend}/100、量能分 ${a.vol}/100。`;
  // 2 籌碼面
  const chip=`外資 ${fmt(s.foreign)} 張、投信 ${fmt(s.trust)} 張、融資 ${fmt(s.margin)}；籌碼分 ${a.chips}/100，${a.chips>=65?'法人偏多、籌碼集中':a.chips<=40?'法人偏空、籌碼鬆動':'籌碼中性'}。`;
  // 3 題材面
  const theme=`新聞情緒 ${news.sentiment}、題材強度 ${news.theme}、社群熱度 ${social.heat}；${news.theme>=70?'題材正在發酵':news.heat>=60?'市場關注度升高':'題材熱度普通'}。`;
  // 4 風險提醒
  const riskItems=[];
  if(es.bias>8)riskItems.push(`正乖離 ${es.bias}%（追高風險）`);
  if(rsi>=75)riskItems.push('RSI 過熱');
  if(n(s.foreign)<0)riskItems.push('外資賣超');
  if(ex.total>=45)riskItems.push(`逃命指數 ${ex.total} 偏高`);
  if(ml.force)riskItems.push('大盤紅燈');
  const risk=riskItems.length?riskItems.join('、'):'目前無明顯風險訊號，仍須嚴設停損。';
  // 5 操作計畫
  let plan;
  if(es.verdict==='可進場')plan=`可於 ${a.buyPoint} 附近、量價不轉弱時建立基本部位（建議 ${a.posPct||20}% 以內），station上 ${ma20.toFixed(2)} 不破為續抱條件。`;
  else if(es.verdict==='等拉回')plan=`暫不追價，等回測 ${ma20.toFixed(2)} 附近不破再進場，勝率較高。`;
  else if(es.verdict==='觀察')plan='列入觀察清單，等量價／籌碼表態明確再評估。';
  else if(es.verdict==='禁止追高')plan='目前禁止開新倉，等風險下降、重新評分後再考慮。';
  else plan='若已持有，優先處理停損與減碼，不要凹單。';
  plan=plan.replace('station上','站上');
  return {
    es,ex,persona:pe,
    items:[
      {n:'1. 技術面解讀',v:tech},
      {n:'2. 籌碼面解讀',v:chip},
      {n:'3. 題材面解讀',v:theme},
      {n:'4. 風險提醒',v:risk},
      {n:'5. 操作計畫',v:plan},
      {n:'6. 進場價',v:`${a.buyPoint}（觀察區）`},
      {n:'7. 停損價',v:`${a.stop}（約 ${(((a.stop-price)/price)*100).toFixed(1)}%）`},
      {n:'8. 第一目標價',v:`${t1.toFixed(2)}（約 +${(((t1-price)/price)*100).toFixed(1)}%）`},
      {n:'9. 第二目標價',v:`${a.t2.toFixed(2)}（約 +${(((a.t2-price)/price)*100).toFixed(1)}%）`},
      {n:'10. 禁止進場條件',v: forb.length?forb.join('；'):'目前未觸發禁止條件（仍須遵守停損與部位上限）。'}
    ]
  };
}
function showCoachReport(id){
  let s=stocks.find(x=>x.id===id); if(!s){const h=holds.find(x=>x.id===id); if(h)s=holdToStock(h);}
  if(!s)return;
  const c=coachReport(s), es=c.es, ex=c.ex;
  const bar=(p,max,red)=>`<div class="ana-bar sm"><i class="${red?'r':''}" style="width:${Math.round(p/max*100)}%"></i></div>`;
  openModal(`<h3>🎓 AI 教練完整報告 · ${s.code} ${s.name||''}</h3>
    <div class="ana-head"><span class="persona">${c.persona.emoji}${c.persona.type}</span>
      <span class="decision-light ${es.vcls}">進場：${es.verdict}</span>
      <span class="decision-light ${ex.acls}">出場：${ex.action}</span></div>
    <div class="ana-big3">
      <div class="b3"><span>AI 進場分</span><b>${es.total}</b></div>
      <div class="b3"><span>逃命指數</span><b class="${ex.total>=60?'neg':''}">${ex.total}</b></div>
      <div class="b3"><span>風險報酬比</span><b>${es.rr}</b></div>
    </div>
    <h4 class="ana-h">📋 十項教練解讀</h4>
    <ul class="coach-report">${c.items.map(it=>`<li><b>${it.n}</b><span>${it.v}</span></li>`).join('')}</ul>
    <div class="modal-foot">
      <button class="btn" onclick="showAnalysis('${id}')">完整數據分析</button>
      <button class="btn primary" onclick="closeModal()">關閉</button>
    </div>`);
}

/* ===================================================================
   六、策略回測中心
   有真實 history（收盤序列）時用真實資料；否則以個股指標確定性模擬，
   並明確標示「模擬」。history 由 fetch-data.js 寫入 data.json。
   =================================================================== */
const BT_STRATS={
  ai80:      {name:'AI 分數 80 以上買進', desc:'站上20MA＋多頭排列＋RSI 55~72＋量增（高分結構代理）'},
  ma20:      {name:'突破 20MA 買進',      desc:'股價由下而上站上 20 日均線當日買進'},
  rsiReb:    {name:'RSI 低檔反彈買進',    desc:'RSI 由 35 以下回升站上 35 買進'},
  inst:      {name:'法人連買買進',        desc:'近 3 日收紅且量能放大（法人連買代理訊號）'},
  volBreak:  {name:'爆量突破買進',        desc:'量 ≥ 1.8 倍均量且突破近 20 日高'}
};
function _sma(arr,i,p){if(i+1<p)return null;let s=0;for(let j=i-p+1;j<=i;j++)s+=arr[j];return s/p;}
function _rsiAt(closes,i,p=14){if(i<p)return 50;let g=0,l=0;for(let j=i-p+1;j<=i;j++){const ch=closes[j]-closes[j-1];ch>=0?g+=ch:l-=ch;}const ag=g/p,al=l/p;if(al===0)return 100;return 100-100/(1+ag/al);}
/* 模擬收盤序列（確定性；以指標推估漂移與波動） */
function synthHistory(s,len=160){
  const seed=_h('H'+(s.code||'')), r=_rng(seed);
  const ma20=n(s.ma20),ma60=n(s.ma60),price=n(s.price)||100,rsi=n(s.rsi)||50;
  const drift=((ma20>ma60?0.0006:-0.0004))+((rsi-50)/50)*0.0004;
  const vol=0.018+(Math.abs(n(s.chg))/100)*0.4;
  const closes=[price],vols=[];
  for(let i=1;i<len;i++){const ret=drift+(r()*2-1)*vol; closes.push(Math.max(1,closes[i-1]*(1+ret)));}
  closes.reverse(); // 讓最後一筆≈現價
  const base=n(s.vol5)||n(s.volume)||10000;
  for(let i=0;i<len;i++)vols.push(Math.round(base*(0.6+r()*1.4)));
  return {closes,vols,sim:true};
}
function stockSeries(s){
  if(Array.isArray(s.history)&&s.history.length>=40){
    const closes=s.history.map(x=>typeof x==='object'?n(x.c):n(x)).filter(v=>v>0);
    const vols=s.history.map(x=>typeof x==='object'?n(x.v):0);
    if(closes.length>=40) return {closes,vols:vols.length?vols:closes.map(()=>n(s.vol5)||1),sim:false};
  }
  return synthHistory(s);
}
/* 單檔模擬：回傳每筆交易報酬(%) */
function btSimulate(series,sigFn,stopPct,targetPct,maxHold){
  const {closes,vols}=series; const rets=[]; let i=30;
  while(i<closes.length-1){
    if(sigFn(closes,vols,i)){
      const entry=closes[i]; let exit=entry,held=0;
      for(let j=i+1;j<closes.length&&held<maxHold;j++,held++){
        const c=closes[j];
        if(c<=entry*(1-stopPct/100)){exit=entry*(1-stopPct/100);break;}
        if(c>=entry*(1+targetPct/100)){exit=entry*(1+targetPct/100);break;}
        exit=c;
      }
      rets.push((exit-entry)/entry*100);
      i+=Math.max(1,held)+1;
    } else i++;
  }
  return rets;
}
function btSignal(key){
  return {
    ai80:(c,v,i)=>{const m20=_sma(c,i,20),m60=_sma(c,i,60),m5=_sma(c,i,5),m10=_sma(c,i,10),rs=_rsiAt(c,i),va=_sma(v,i,5);
      return m20&&m60&&m5&&m10&&c[i]>m20&&m20>m60&&m5>m10&&rs>=55&&rs<=72&&(va?v[i]>va:true);},
    ma20:(c,v,i)=>{const m=_sma(c,i,20),mp=_sma(c,i-1,20); return m&&mp&&c[i-1]<=mp&&c[i]>m;},
    rsiReb:(c,v,i)=>{const a=_rsiAt(c,i-1),b=_rsiAt(c,i); return a<35&&b>=35;},
    inst:(c,v,i)=>{const va=_sma(v,i,5); return c[i]>c[i-1]&&c[i-1]>c[i-2]&&c[i-2]>c[i-3]&&(va?v[i]>va*1.1:true);},
    volBreak:(c,v,i)=>{const va=_sma(v,i,20); let hi=0;for(let j=i-20;j<i;j++)if(c[j]>hi)hi=c[j]; return va&&v[i]>=va*1.8&&c[i]>hi;}
  }[key];
}
function runBacktest(key,opts={}){
  const universe=stocks.length?stocks:[];
  const maxHold=opts.maxHold||20;
  const sig=btSignal(key);
  // 主結果（用使用者預設停損停利）
  const stop=opts.stop||8, target=opts.target||15;
  let all=[], sim=false, used=0;
  universe.forEach(s=>{const ser=stockSeries(s); if(ser.sim)sim=true; const r=btSimulate(ser,sig,stop,target,maxHold); if(r.length){all=all.concat(r);used++;}});
  const agg=btAgg(all);
  // 網格搜尋最佳停損/停利
  let best=null;
  [3,5,8,10,12].forEach(st=>[5,8,10,15,20,25].forEach(tg=>{
    let rr=[]; universe.forEach(s=>{rr=rr.concat(btSimulate(stockSeries(s),sig,st,tg,maxHold));});
    const a=btAgg(rr); const score=a.n?(a.winRate/100)*a.avg:-999;
    if(!best||score>best.score)best={score,stop:st,target:tg,winRate:a.winRate,avg:a.avg,n:a.n};
  }));
  return {...agg, sim, used, total:universe.length, best, stop, target, strat:BT_STRATS[key]};
}
function btAgg(rets){
  const n0=rets.length; if(!n0)return {n:0,winRate:0,avg:0,mdd:0,pf:0};
  const wins=rets.filter(r=>r>0), losses=rets.filter(r=>r<=0);
  const gp=wins.reduce((a,b)=>a+b,0), gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  // 權益曲線（複利）與最大回撤
  let eq=100,peak=100,mdd=0; rets.forEach(r=>{eq*=(1+r/100);peak=Math.max(peak,eq);mdd=Math.min(mdd,(eq-peak)/peak*100);});
  return {n:n0, winRate:+(wins.length/n0*100).toFixed(1), avg:+(rets.reduce((a,b)=>a+b,0)/n0).toFixed(2),
    mdd:+mdd.toFixed(1), pf:gl?+(gp/gl).toFixed(2):(gp>0?99:0), finalEq:+eq.toFixed(1)};
}

/* ===================================================================
   渲染：回測中心 / 今日速報 / 增強進出場與部位 / 復盤
   =================================================================== */
function renderBacktest(){
  const box=$('#backtestResult'); if(!box)return;
  const key=($('#btStrat')&&$('#btStrat').value)||'ai80';
  const stop=n($('#btStop')&&$('#btStop').value)||8, target=n($('#btTarget')&&$('#btTarget').value)||15;
  if(!stocks.length){box.innerHTML='<p class="muted">股池為空，請先到「選股中心」載入今日數據或新增股票。</p>';return;}
  const R=runBacktest(key,{stop,target});
  const kpi=(k,v,c)=>`<div class="card glass kpi"><span class="kpi-label">${k}</span><span class="kpi-val ${c||''}" style="font-size:20px">${v}</span></div>`;
  box.innerHTML=`
    <div class="verdict ${R.winRate>=55?'go':R.winRate>=45?'watch':'stop'}">
      <h2>${R.strat.name}</h2>
      <div class="muted">${R.strat.desc}</div>
      <div class="muted" style="margin-top:6px">回測標的 ${R.used}/${R.total} 檔 · 訊號樣本 ${R.n} 筆 · 停損 ${R.stop}% / 停利 ${R.target}% · 最長持有 20 日
        ${R.sim?'<span class="badge" style="background:#3a2a12;color:#ffcf5c;border-color:#5a4422">⚠ 含模擬歷史資料</span>':'<span class="badge">真實歷史</span>'}</div>
    </div>
    <div class="grid kpi-grid">
      ${kpi('勝率',R.winRate+'%',R.winRate>=50?'':'neg')}
      ${kpi('平均報酬',(R.avg>=0?'+':'')+R.avg+'%',R.avg>=0?'':'neg')}
      ${kpi('最大回撤',R.mdd+'%','neg')}
      ${kpi('盈虧比',R.pf,R.pf>=1.5?'':'neg')}
      ${kpi('權益終值',R.finalEq,R.finalEq>=100?'':'neg')}
      ${kpi('樣本數',R.n)}
    </div>
    <div class="card glass">
      <h3>🔧 參數最佳化（網格搜尋）</h3>
      ${R.best&&R.best.n?`<p>此策略在回測區間的<strong>最佳組合</strong>：停損 <b style="color:var(--green)">${R.best.stop}%</b> ／ 停利 <b style="color:var(--green)">${R.best.target}%</b>
        → 勝率 ${R.best.winRate}%、平均報酬 ${R.best.avg>=0?'+':''}${R.best.avg}%（樣本 ${R.best.n}）。</p>
        <button class="btn" onclick="$('#btStop').value=${R.best.stop};$('#btTarget').value=${R.best.target};renderBacktest()">套用最佳參數</button>`
        :'<p class="muted">樣本不足，無法最佳化。</p>'}
    </div>
    <p class="muted">※ 回測為歷史統計，非未來保證；模擬資料僅供策略邏輯比較，正式請以 FinMind/TWSE 歷史日K 回填 data.json 的 history 欄位。</p>`;
}

/* 九、手機今日速報（3 秒看懂） */
function renderTodaySummary(){
  const host=$('#todaySummary'); if(!host)return;
  const ml=marketLight();
  const adv=stocks.map(s=>({s,e:entryScore100(s)}));
  const canBuy=adv.filter(x=>x.e.verdict==='可進場').sort((a,b)=>b.e.total-a.e.total);
  const forbid=adv.filter(x=>x.e.verdict==='禁止追高'||x.e.verdict==='停損警示');
  const reduce=holds.map(h=>({h,x:escapeScore100(holdToStock(h))})).filter(o=>o.x.total>=45).sort((a,b)=>b.x.total-a.x.total);
  // 今日紀律分
  const rec=(coach[today()]||{checks:{}}).checks; const disc=Math.round(Object.values(rec).filter(Boolean).length/6*100);
  const canTrade = !ml.force;
  const chip=(arr,fn,cls)=>arr.length?arr.slice(0,6).map(fn).join(''):`<span class="muted">${cls||'無'}</span>`;
  host.innerHTML=`
   <div class="today-hero ${ml.css||''}">
     <div class="th-row th-main">
       <div class="th-can ${canTrade?'go':'stop'}">
         <span class="th-q">今天能不能買？</span>
         <span class="th-a">${canTrade?'✅ 可以（'+ml.label+'）':'⛔ 不行 · 大盤'+ml.label}</span>
       </div>
       <div class="th-disc"><span>今日紀律</span><b class="${disc>=70?'pos':disc>=50?'':'neg'}">${disc}</b></div>
     </div>
     <div class="th-grid">
       <div class="th-cell"><div class="th-h go">🟢 可進場 ${canBuy.length}</div><div class="th-chips">${chip(canBuy,x=>`<span class="chip" onclick="showCoachReport('${x.s.id}')">${x.s.code} ${x.s.name||''} ${x.e.total}</span>`,'今日無')}</div></div>
       <div class="th-cell"><div class="th-h stop">⛔ 禁止 ${forbid.length}</div><div class="th-chips">${chip(forbid,x=>`<span class="chip neg" onclick="showCoachReport('${x.s.id}')">${x.s.code} ${x.s.name||''}</span>`,'無')}</div></div>
       <div class="th-cell"><div class="th-h watch">🔻 持股減碼 ${reduce.length}</div><div class="th-chips">${chip(reduce,o=>`<span class="chip neg" onclick="showCard('${o.h.id}')">${o.h.code} ${o.h.name||''} ${o.x.action}</span>`,'持股安全')}</div></div>
     </div>
   </div>`;
}

/* 增強：進場引擎（100 分制） */
function showEntry(id){
  const s=stocks.find(x=>x.id===id); const box=$('#entryResult');
  if(!s){box.innerHTML='';return;}
  const es=entryScore100(s), fr=fiveRules(s), bi=bottomIndex(s), tp=targetPrices(s), pe=persona(s), ml=marketLight();
  const forb=forbidEntry(s);
  const bar=(p,max,cls)=>`<div class="score-line"><div class="sl-top"><span>${p.k}</span><b>${p.v}/${p.max}</b></div><div class="ana-bar"><i class="${cls||''}" style="width:${Math.round(p.v/p.max*100)}%"></i></div><div class="sl-d muted">${p.d}</div></div>`;
  box.innerHTML=`
   <div class="verdict ${es.vcls}">
     <h2>${es.verdict} · AI 進場分 ${es.total}</h2>
     <div class="muted">${s.code} ${s.name||''} · <span class="persona">${pe.emoji}${pe.type}</span> · 大盤 <b>${ml.label}</b> · 風報比 ${es.rr}</div>
   </div>
   <div class="card glass">
     <h3>🎯 AI 進場分數 100 分制</h3>
     ${es.parts.map(p=>bar(p,p.max,p.k==='風險報酬比'&&p.v<5?'r':'')).join('')}
     <div class="entry-total">合計 <b>${es.total}</b> / 100</div>
   </div>
   ${forb.length?`<div class="forbid-box">⛔ 觸發禁止進場：<ul>${forb.map(r=>`<li>${r}</li>`).join('')}</ul></div>`:''}
   <div class="grid g2">
     <div class="card glass"><h3>🧱 五鐵律</h3><ul class="factor-list">${fr.items.map(i=>`<li><span>${i.n}</span><span class="${i.ok?'tick':'cross'}">${i.ok?'✔':'✘'}</span></li>`).join('')}</ul></div>
     <div class="card glass"><h3>🩸 抄底指數 ${bi.score}</h3><ul class="factor-list">${bi.factors.map(f=>`<li><span>${f.n}</span><span>${f.p}/${f.max}</span></li>`).join('')}</ul></div>
   </div>
   <div class="card glass"><h3>🎯 AI 目標價（${tp.basis}）</h3>
     <div class="target-row">${[['停損',es.stop],['第一目標',tp.t1],['第二目標',tp.t2],['第三目標',tp.t3]].map(([k,v])=>`<div class="target"><div class="lvl">${k}</div><div class="p">${n(v).toFixed(2)}</div><div class="${v<es.stop+0.01&&k==='停損'?'neg':'up'}">${k==='停損'?((v-n(s.price))/n(s.price)*100).toFixed(1):'+'+((v-tp.price)/tp.price*100).toFixed(1)}%</div></div>`).join('')}</div>
     <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
       <button class="btn" onclick="showCoachReport('${s.id}')">🎓 教練報告</button>
       <button class="btn full" onclick="toRiskFromStock('${s.id}')">→ 帶入部位計算機</button>
     </div>
   </div>`;
}

/* 增強：出場引擎（逃命 100 分制 七因子） */
function showExit(val){
  const box=$('#exitResult'); if(!val){box.innerHTML='';return;}
  const [t,id]=val.split(':'); let s,hold=null;
  if(t==='s') s=stocks.find(x=>x.id===id);
  else {hold=holds.find(x=>x.id===id); if(hold)s=holdToStock(hold);}
  if(!s){box.innerHTML='';return;}
  const ex=escapeScore100(s);
  box.innerHTML=`
   <div class="verdict ${ex.acls}">
     <h2>逃命指數 ${ex.total} · ${ex.action}</h2>
     <div class="muted">${s.code} ${s.name||''}${hold?` · 持股 ${fmt(hold.shares)} 張 · 成本 ${fmt(hold.buy)}`:''}</div>
   </div>
   <div class="card glass"><h3>🔥 七大逃命因子</h3>
     <ul class="factor-list">${ex.factors.map(f=>`<li><span>${f.n}</span><span class="${f.on?'cross':'tick'}">${f.on?'⚠ +'+f.p:'0'}/${f.max}</span></li>`).join('')}</ul>
     <p class="muted">${ex.total>=85?'⛔ 強制停損：訊號嚴重轉弱，立即出場保護本金。':ex.total>=65?'🔴 全部出場：多項轉弱訊號同時成立。':ex.total>=45?'🟠 減碼 1/2：風險升高，先鎖定一半獲利。':ex.total>=25?'🟡 減碼 1/3：出現轉弱跡象，移動停利。':'🟢 續抱：尚無明顯轉弱訊號。'}</p>
     ${hold?`<button class="btn full" onclick="closeHold('${hold.id}')">→ 執行平倉 / 復盤</button>`:''}
   </div>`;
}

/* 增強：部位計算（支援絕對停損價） */
function calcRisk(){
  const buy=n($('#rkBuy').value);
  const stopPrice = ($('#rkStopPrice')&&$('#rkStopPrice').value!=='')? n($('#rkStopPrice').value) : buy*(1-(n($('#rkStop').value)||8)/100);
  const target=n($('#rkTarget').value);
  const cap=n($('#rkCapital').value)||cfg.capital, riskPct=n($('#rkRisk').value)||cfg.risk;
  if(!buy){toast('請輸入買進價');return;}
  const p=positionPlan({capital:cap,riskPct,buy,stop:stopPrice,target});
  $('#rkOut').innerHTML=`<h3>計算結果</h3>
    <div class="verdict ${p.wcls}" style="margin-bottom:10px"><h2 style="font-size:20px">${p.worth}</h2><div class="muted">${p.reason}</div></div>
    <ul class="factor-list">
      <li><span>停損價</span><b>${stopPrice.toFixed(2)}（${p.stopPctV}%）</b></li>
      <li><span>每股風險</span><b>${p.lps.toFixed(2)}</b></li>
      <li><span>最大可買張數</span><b style="color:var(--green)">${p.lots} 張</b></li>
      <li><span>最大虧損金額</span><b class="neg">${money(p.maxLoss)}</b></li>
      <li><span>投入成本</span><b>${money(p.cost)}</b></li>
      <li><span>可承受風險(${riskPct}%)</span><b>${money(p.riskAmt)}</b></li>
      <li><span>風險報酬比</span><b>${p.rr?('1 : '+p.rr):'—'}</b></li>
    </ul>`;
}
function toRiskFromStock(id){const s=stocks.find(x=>x.id===id);if(!s)return;const es=entryScore100(s);
  switchTab('risk');$('#rkBuy').value=s.price;if($('#rkStopPrice'))$('#rkStopPrice').value=es.stop;$('#rkTarget').value=es.t1;
  $('#rkCapital').value=cfg.capital;$('#rkRisk').value=cfg.risk;calcRisk();}

/* ===================================================================
   八、交易復盤（結構化）— 覆寫 closeHold / doCloseHold / renderTrades
   =================================================================== */
const REVIEW_Q=[
  {k:'bySystem',label:'有照系統訊號進場'},
  {k:'noChase',label:'沒有追高買進'},
  {k:'hadStop',label:'進場前有設停損'},
  {k:'byStop',label:'有照停損紀律出場'}
];
function closeHold(id){
  const h=holds.find(x=>x.id===id);if(!h)return;
  openModal(`<h3>平倉 → 交易復盤</h3>
  <div class="form-grid">
    ${field('賣出日期','f_sellDate',today(),'date')}${field('賣出價格','f_sell',h.price)}
  </div>
  <h4 class="ana-h">🧾 交易復盤檢核</h4>
  <div class="review-grid">${REVIEW_Q.map(q=>`<label class="check"><input type="checkbox" data-rk="${q.k}"> ${q.label}</label>`).join('')}</div>
  <div class="form-grid">
    <div class="span2"><label>出場原因</label><textarea id="f_reasonOut" placeholder="達標停利 / 跌破停損 / 訊號轉弱 …"></textarea></div>
    <div class="span2"><label>這次交易學到什麼</label><textarea id="f_lesson" placeholder="例：進場太早、停損設太寬、追高被套 …"></textarea></div>
  </div>
  <div class="modal-foot"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="doCloseHold('${id}')">確認平倉</button></div>`);
}
function reviewCoachLine(rev,profit){
  if(!rev.hadStop)return '下次進場前一定要先寫好停損價，沒有停損的單就是賭博。';
  if(!rev.byStop && profit<0)return '這次沒照停損出場才放大虧損，紀律比預測更重要，凹單會吃掉長期報酬。';
  if(rev.noChase===false)return '追高是勝率殺手，等回測均線不破再進場，期望值會明顯提升。';
  if(!rev.bySystem)return '這是一筆系統外的交易，盡量只做系統高分訊號，減少情緒化決策。';
  if(profit>0)return '紀律到位且獲利，把這套流程固定下來、重複執行就是你的優勢。';
  return '流程正確、結果不如預期是正常的，守住紀律，讓大數法則站在你這邊。';
}
function doCloseHold(id){
  const h=holds.find(x=>x.id===id);if(!h)return; const sell=n($('#f_sell').value);
  const pnl=(sell-n(h.buy))*n(h.shares)*1000;
  const rev={}; document.querySelectorAll('#modalBox input[data-rk]').forEach(i=>rev[i.dataset.rk]=i.checked);
  const lesson=($('#f_lesson')&&$('#f_lesson').value)||'';
  const coachLine=reviewCoachLine(rev,pnl);
  trades.push({id:uid(),buyDate:h.buyDate,sellDate:$('#f_sellDate').value,code:h.code,name:h.name,buy:h.buy,sell:sell,
    shares:h.shares,pnl:pnl,reasonIn:h.reasonIn||'',reasonOut:($('#f_reasonOut')&&$('#f_reasonOut').value)||'',
    review:rev,lesson,coachLine});
  holds=holds.filter(x=>x.id!==id);save();closeModal();renderAll();
  toast('已平倉並完成復盤');
  setTimeout(()=>openModal(`<h3>🎓 復盤完成 · 教練回饋</h3>
    <div class="verdict ${pnl>=0?'go':'stop'}"><h2>${h.code} ${h.name||''}　${money(pnl)}</h2></div>
    <ul class="coach-report"><li><b>出場原因</b><span>${($('#f_reasonOut')&&$('#f_reasonOut').value)||'—'}</span></li>
      <li><b>復盤檢核</b><span>${REVIEW_Q.map(q=>`${rev[q.k]?'✅':'⛔'}${q.label}`).join('　')}</span></li>
      <li><b>本次學到</b><span>${lesson||'—'}</span></li>
      <li><b>教練建議</b><span>🧭 ${coachLine}</span></li></ul>
    <div class="modal-foot"><button class="btn primary" onclick="closeModal()">收下，繼續精進</button></div>`),250);
}
function renderTrades(){
  const tb=$('#tradeTable tbody');if(!tb)return;tb.innerHTML='';
  const empty=$('#tradeEmpty'); if(empty)empty.style.display=trades.length?'none':'block';
  trades.slice().sort((a,b)=>(b.sellDate||'').localeCompare(a.sellDate||'')).forEach(t=>{
    const roi=n(t.buy)?(n(t.sell)-n(t.buy))/n(t.buy)*100:0;
    const rv=t.review||{};
    const badges=t.review?REVIEW_Q.map(q=>`<span class="rv ${rv[q.k]?'ok':'no'}" title="${q.label}">${rv[q.k]?'✓':'✗'}</span>`).join(''):'';
    tb.innerHTML+=`<tr><td>${t.buyDate||'-'}</td><td>${t.sellDate||'-'}</td><td>${t.code} ${t.name||''}</td>
      <td>${fmt(t.buy)}</td><td>${fmt(t.sell)}</td><td>${fmt(t.shares)}</td>
      <td class="${cls(n(t.pnl))}">${money(n(t.pnl))}</td><td class="${cls(roi)}">${pct(roi)}</td>
      <td class="l">${t.reasonIn||'-'}</td><td class="l">${t.reasonOut||'-'} ${t.coachLine?`<br><span class="muted" style="font-size:11px">🧭 ${t.coachLine}</span>`:''} ${badges?`<div class="rv-row">${badges}</div>`:''}</td>
      <td><button class="link" onclick="editTrade('${t.id}')">編輯</button> · <button class="link" onclick="delTrade('${t.id}')">刪</button></td></tr>`;
  });
}

/* ===================================================================
   分頁掛載 / 初始化
   =================================================================== */
const _origSwitchTab = (typeof switchTab==='function')?switchTab:null;
switchTab=function(tab){
  if(_origSwitchTab)_origSwitchTab(tab);
  if(tab==='backtest')renderBacktest();
};
// 將今日速報塞進渲染流程：包裝 renderDashboard
const _origRenderDashboard=(typeof renderDashboard==='function')?renderDashboard:null;
renderDashboard=function(){ if(_origRenderDashboard)_origRenderDashboard(); renderTodaySummary(); };

// 綁定回測控制項（DOM 已存在）
function bindPro(){
  const run=$('#btRun'); if(run)run.onclick=renderBacktest;
  ['#btStrat','#btStop','#btTarget'].forEach(id=>{const e=$(id);if(e)e.onchange=renderBacktest;});
}
bindPro();
// 首次整體刷新（套用四燈號 / 速報 / 覆寫的進出場）
if(typeof renderAll==='function')renderAll();
