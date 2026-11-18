/**
 * 배포 주소가 확정된 뒤에 QR 스티커를 만든다.  npm run make:qr -- https://<사용자>.github.io/<저장소>/
 * 주소를 추측해서 만들지 않는다: 인자가 없으면 아무것도 만들지 않는다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import QRCode from 'qrcode';

const url = process.argv[2];
if (!url || !/^https:\/\/[^\s]+$/.test(url)) {
  console.error('사용법: npm run make:qr -- https://<실제 배포 주소>/\n(배포해서 주소가 확정된 뒤에 실행하세요. HTTPS 만 받습니다.)');
  process.exit(1);
}
const out = resolve(import.meta.dirname, '../assets/qr');
mkdirSync(out, { recursive: true });
// 오류 정정 Q: 스티커가 조금 긁히거나 반사돼도 읽힌다.
const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'Q', margin: 4, color: { dark: '#000000', light: '#FFFFFF' } });
writeFileSync(resolve(out, 'poster-qr.svg'), svg);
await QRCode.toFile(resolve(out, 'poster-qr.png'), url, { errorCorrectionLevel: 'Q', margin: 4, width: 1200 });
console.log(`QR 생성: ${out}\n  내용: ${url}\n  인쇄 크기 권장: 한 변 45~50 mm (포스터 CONCLUSIONS 띠 오른쪽 빈 곳)`);
