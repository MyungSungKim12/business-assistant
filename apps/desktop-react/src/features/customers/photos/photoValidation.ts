import type { BinarySource } from '../../../platform/types';
const types=['image/jpeg','image/png','image/webp'];export function validatePhoto(file:BinarySource){if(!types.includes(file.contentType))throw new Error('JPEG, PNG, WebP 사진만 등록할 수 있습니다.');if(file.size<=0||file.size>10*1024*1024)throw new Error('사진은 10MB 이하여야 합니다.');}
