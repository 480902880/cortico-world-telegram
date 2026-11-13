/**
 * 图片字节的探测与判断。
 *
 * 为什么需要：Telegram 的 photo 消息**不带 MIME**（只有尺寸列表），落盘时文件名也没扩展名，
 * 所以「这张图模型能不能看」只能靠魔术字节判断，不能靠扩展名。
 */

/** 从前几个字节认出常见图片格式；认不出返回 null。 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  // WEBP: "RIFF"…"WEBP"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/** 模型能不能视图这种图（先看 MIME 是不是图片，再交给调用方问模型能力）。 */
export function isViewableImage(mime: string | null | undefined): boolean {
  return !!mime && /^image\/(png|jpeg|jpg|gif|webp)$/i.test(mime);
}
