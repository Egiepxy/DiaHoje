'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const PORT=Number(process.env.PORT)||3000, ROOT=path.resolve(__dirname);
const intervals={Min5:300,Min15:900,Min60:3600,Hour4:14400,Day1:86400};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'https://egiepxy.github.io','Vary':'Origin'});res.end(JSON.stringify(obj));}
async function mexc(endpoint){
 const c=new AbortController(),timeout=setTimeout(()=>c.abort(),14500);
 try{
  const r=await fetch('https://contract.mexc.com/api/v1/contract/'+endpoint,{signal:c.signal,headers:{Accept:'application/json','User-Agent':'SetupEgiP/54.3'}});
  if(!r.ok)throw Error('MEXC HTTP '+r.status);
  const j=await r.json();if(j.success===false||!j.data)throw Error(j.message||'Resposta MEXC sem dados');
  return j.data;
 }finally{clearTimeout(timeout);}
}
http.createServer(async(req,res)=>{
 try{
  if(req.method!=='GET'){send(res,405,{success:false,message:'Método não suportado'});return;}
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/health'){send(res,200,{success:true,service:'SetupEgiP proxy',routes:['/api/kline','/api/mexc/contracts']});return;}
  if(u.pathname==='/api/mexc/contracts'){
    const data=await mexc('ticker');
    if(!Array.isArray(data))throw Error('Lista MEXC inválida');
    send(res,200,{success:true,data});return;
  }
  if(u.pathname==='/api/kline'){
    const symbol=u.searchParams.get('symbol')||'';
    const interval=u.searchParams.get('interval')||'';
    if(!/^[A-Z0-9]{2,30}_USDT$/.test(symbol)||!intervals[interval]){send(res,400,{success:false,message:'Símbolo ou timeframe inválido'});return;}
    const now=Math.floor(Date.now()/1000),secs=intervals[interval];
    const start=now-secs*520;
    const data=await mexc('kline/'+encodeURIComponent(symbol)+'?interval='+interval+'&start='+start+'&end='+now);
    const length=data.time?.length||0;
    if(!length)throw Error('MEXC retornou zero candles');
    const keys=['time','high','low','close','vol'];
    if(keys.some(k=>!Array.isArray(data[k])||data[k].length!==length))throw Error('Formato de candles inconsistente');
    const selected=Array.from({length},(_,i)=>i).filter(i=>{
      const t=Number(data.time[i]),h=Number(data.high[i]),l=Number(data.low[i]),c=Number(data.close[i]);
      return Number.isFinite(t)&&t+secs<=now&&[h,l,c].every(Number.isFinite)&&l>0&&h>=l&&c>=l&&c<=h;
    });
    if(selected.length<210)throw Error('Histórico insuficiente ('+selected.length+' candles fechados)');
    const clean={};
    keys.forEach(k=>clean[k]=selected.map(i=>Number(data[k][i])));
    clean.open=selected.map(i=>Array.isArray(data.open)&&Number.isFinite(Number(data.open[i]))?Number(data.open[i]):Number(data.close[Math.max(0,i-1)]));
    send(res,200,{success:true,data:{...clean,source:'MEXC Futures via servidor SetupEgiP',requestedSymbol:symbol,referenceSymbol:symbol}});
    return;
  }
  let requested=decodeURIComponent(u.pathname);
  if(requested==='/')requested='/index.html';
  const file=path.resolve(ROOT,'.'+requested);
  if(!file.startsWith(ROOT+path.sep)){send(res,403,{success:false,message:'Acesso negado'});return;}
  fs.stat(file,(err,stat)=>{
   if(err||!stat.isFile()){send(res,404,{success:false,message:'Arquivo não encontrado'});return;}
   res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});
   fs.createReadStream(file).pipe(res);
  });
 }catch(e){send(res,502,{success:false,message:'Fonte MEXC indisponível: '+e.message});}
}).listen(PORT,'0.0.0.0',()=>console.log('SetupEgiP servidor porta '+PORT));
