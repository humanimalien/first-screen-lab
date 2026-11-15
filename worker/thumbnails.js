import decodeJpeg from 'jpeg-js/lib/decoder.js';
import {decode as decodePng,encode as encodePng} from 'fast-png';

// The stored preview always contains exactly one 96 × 60 raster, without source metadata.
const thumbWidth=96,thumbHeight=60;
function encodeThumbnail(rgba){
  return encodePng({width:thumbWidth,height:thumbHeight,channels:4,data:rgba});
}
async function saveThumbnail(bucket,key,file){
  if(!file || file.size!==thumbWidth*thumbHeight*4)return;
  const rgba=new Uint8Array(await file.arrayBuffer());
  await bucket.put('tile/'+key,encodeThumbnail(rgba));
}
function historicalThumbnail(bytes,mime){
  const image=mime==='image/jpeg'
    ? {...decodeJpeg(bytes,{useTArray:true}),channels:4,depth:8}
    : decodePng(bytes);
  const {width,height,channels,depth,palette,data}=image;
  const scale=Math.min(thumbWidth/width,thumbHeight/height);
  const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
  const left=Math.floor((thumbWidth-w)/2),top=Math.floor((thumbHeight-h)/2);
  const rgba=new Uint8Array(thumbWidth*thumbHeight*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const sy=Math.floor((y+0.5)*height/h),sx=Math.floor((x+0.5)*width/w);
    const index=(sy*width+sx)*channels;
    const dst=((y+top)*thumbWidth+x+left)*4;
    let first=data[index];
    if(depth<8){
      const byte=data[sy*Math.ceil(width*depth/8)+Math.floor(sx*depth/8)];
      first=(byte>>(8-depth-(sx*depth)%8))&((1<<depth)-1);
    }
    if(palette){
      const color=palette[first];
      rgba.set([color[0],color[1],color[2],color[3]??255],dst);
    }else{
      const factor=255/(2**depth-1);
      for(let c=0;c<3;c++)rgba[dst+c]=(channels>=3?data[index+c]:first)*factor;
      rgba[dst+3]=channels===2||channels===4?data[index+channels-1]*factor:255;
    }
  }
  return encodeThumbnail(rgba);
}
async function studentThumbnail(query,bucket,id,v,version){
  const next=await query(`SELECT x.id FROM versions x LEFT JOIN attempts a ON a.version=x.id AND a.viewer=?
    WHERE x.author=? AND x.author<>? AND x.deleted=0 AND x.route_attempt=? AND a.finished IS NULL ORDER BY x.seq LIMIT 1`,id,version.author,id,version.route_attempt).first();
  if(next?.id!==v)fail('Эта версия сейчас недоступна для проверки.',403);
  const key='tile/'+version.file_key;
  const cached=await bucket.get(key);
  let body=cached?.body;
  if(!body){
    const original=await bucket.get(version.file_key);
    if(!original)fail('Эскиз не найден.',404);
    body=historicalThumbnail(new Uint8Array(await new Response(original.body).arrayBuffer()),version.mime);
    await bucket.put(key,body);
  }
  return new Response(body,{headers:{...privateHeaders,'Content-Type':'image/png'}});
}
