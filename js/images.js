// 画像の圧縮。
// 画像は Firestore のドキュメント（1 件 1MB まで）に入れるので、
// 長辺 1280px の WebP にして、だいたい 150KB 前後・最大でも 700KB に収める。

const MAX_SIDE = 1280;
const MAX_CHARS = 700 * 1024; // data URL の文字数の上限（ドキュメント上限 1MB に余裕を持たせる）

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

// File / Blob → { data: 'data:image/webp;base64,...', w, h }
export async function compressImage(blob) {
  const img = await loadImage(blob);
  let scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    for (const quality of [0.8, 0.65, 0.5]) {
      // WebP に対応していないブラウザ（古い Safari）では JPEG になる
      const data = canvas.toDataURL('image/webp', quality);
      if (data.length <= MAX_CHARS) return { data, w, h };
    }
    scale *= 0.75;
  }
  throw new Error('画像が大きすぎます');
}

// 貼り付け・ドロップされたデータから画像ファイルを取り出す
export function imageFromTransfer(dt) {
  for (const item of dt?.items ?? []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return [...(dt?.files ?? [])].find((f) => f.type.startsWith('image/')) ?? null;
}
