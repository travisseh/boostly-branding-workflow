import sharp from 'sharp';
import fs from 'node:fs';
const dir = '/private/tmp/claude-501/-Users-travisse-Programming-projects-brand-design-spike-2026-07-06/50ca2f9d-e925-469b-8cd5-f755ba789fc9/scratchpad/figma-compare/';
const files = fs.readdirSync(dir).filter(f => f.startsWith('figma-') && f.endsWith('.png'));
const near=(a,b,tol=45)=>Math.abs(a[0]-b[0])<=tol&&Math.abs(a[1]-b[1])<=tol&&Math.abs(a[2]-b[2])<=tol;
const isWhite=p=>p[0]>235&&p[1]>235&&p[2]>235;
for (const f of files) {
  const { data, info } = await sharp(dir+f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const px=(x,y)=>{const i=(y*w+x)*4;return [data[i],data[i+1],data[i+2]];};
  const band = px(w-30, Math.floor(h*0.25)); // deep inside band top-right
  // per-column band bottom (top contiguous band run, skipping white border)
  const bandBottom = new Array(w).fill(-1);
  for (let x=4;x<w-4;x++){
    let y=6;
    while(y<h && !near(px(x,y),band)) { if(!isWhite(px(x,y))) break; y++; }
    if (y>=h || !near(px(x,y),band)) continue; // never enters band cleanly
    while(y<h && near(px(x,y),band)) y++;
    bandBottom[x]=y-1;
  }
  const maxBB=Math.max(...bandBottom);
  const bbAt=x=>bandBottom[x]>=0?bandBottom[x]:0;
  // divider: contiguous columns near center whose lower region is mostly band-colored
  const isDivCol=x=>{ let run=0,tot=0; for(let y=bbAt(x)+8;y<h;y++){tot++; if(near(px(x,y),band))run++;} return tot>0&&run/tot>0.92; };
  let divL=null,divR=null;
  for(let x=Math.floor(w*0.35);x<Math.floor(w*0.65);x++){ if(isDivCol(x)){ if(divL===null)divL=x; divR=x; } }
  let qx0=w,qx1=0,qy0=h,qy1=0,lx0=w,lx1=0,ly0=h,ly1=0;
  for (let x=4;x<w-4;x++){
    if(divL!==null&&x>=divL-3&&x<=divR+3) continue;
    for(let y=bbAt(x)+6;y<h-4;y++){
      const p=px(x,y); if(isWhite(p)) continue;
      if(x>w*0.5){ if(near(p,band,80)){ if(x<qx0)qx0=x; if(x>qx1)qx1=x; if(y<qy0)qy0=y; if(y>qy1)qy1=y; } }
      else { if(x<lx0)lx0=x; if(x>lx1)lx1=x; if(y<ly0)ly0=y; if(y>ly1)ly1=y; }
    }
  }
  const r=(v,base)=>+(v/base).toFixed(4);
  console.log(JSON.stringify({ file:f, band:`rgb(${band})`,
    bandBottom:{left:bbAt(20),right:bbAt(w-21),leftFrac:r(bbAt(20),h),rightFrac:r(bbAt(w-21),h)},
    divider:divL!==null?{x0:divL,x1:divR,wpx:divR-divL+1,cxFrac:r((divL+divR)/2,w)}:null,
    qr:{x:qx0,y:qy0,w:qx1-qx0+1,h:qy1-qy0+1,wFrac:r(qx1-qx0+1,w),xFrac:r(qx0,w),yFrac:r(qy0,h),rightMFrac:r(w-1-qx1,w),bottomMFrac:r(h-1-qy1,h)},
    logo:{x:lx0,y:ly0,w:lx1-lx0+1,h:ly1-ly0+1,wFrac:r(lx1-lx0+1,w),hFrac:r(ly1-ly0+1,h),xFrac:r(lx0,w),yFrac:r(ly0,h),bottomMFrac:r(h-1-ly1,h)}
  }));
}
