'use strict';

const scanOcr = require('./scan-ocr');
const scanVision = require('./scan-vision');

function visionFallbackEnabled() {
  const v = process.env.SCAN_VISION_FALLBACK;
  if (v === '0' || v === 'false') return false;
  const cfg = scanVision.getConfig();
  return cfg.enabled && !!cfg.apiKey;
}

/**
 * Hybrid: Tesseract OCR trước, Claude Vision khi OCR không đủ tin cậy.
 * @param {Buffer} imageBuffer
 * @param {string} channel xskt | vietlott | auto
 * @param {{ clientIp?: string, userAgent?: string }} meta
 */
async function scanTicketFromImage(imageBuffer, channel, meta) {
  meta = meta || {};
  const ch = String(channel || 'auto').toLowerCase().trim();
  const started = Date.now();

  const ocr = await scanOcr.tryScanWithOcr(imageBuffer, ch);
  if (ocr.ok && ocr.data) {
    scanVision.pushScanLog({
      at: new Date().toISOString(),
      ip: String(meta.clientIp || 'unknown').slice(0, 64),
      channel: ch,
      success: true,
      engine: 'tesseract',
      ms: ocr.ms || Date.now() - started,
      confidence: ocr.confidence,
      result: ocr.data,
    });
    return {
      success: true,
      source: 'tesseract',
      ocr: {
        confidence: ocr.confidence,
        textPreview: ocr.text,
        ms: ocr.ms,
      },
      data: ocr.data,
    };
  }

  if (!visionFallbackEnabled()) {
    const cfg = scanVision.getConfig();
    let err = 'Không đọc được vé bằng OCR.';
    if (!scanOcr.getOcrConfig().enabled) err += ' OCR đang tắt.';
    else if (ocr.error) err += ' (' + ocr.error + ')';
    if (!cfg.enabled || !cfg.apiKey) {
      err += ' Vision fallback chưa bật (SCAN_VISION_ENABLED + ANTHROPIC_API_KEY).';
    }
    return {
      success: false,
      status: 422,
      error: err,
      ocr: ocr.text ? { textPreview: ocr.text, confidence: ocr.confidence } : undefined,
    };
  }

  const vision = await scanVision.scanTicketWithVision(imageBuffer, ch, meta);
  if (vision.success) {
    return {
      ...vision,
      source: 'claude-vision',
      fallbackFromOcr: true,
      ocr: ocr.text
        ? { textPreview: ocr.text, confidence: ocr.confidence, error: ocr.error }
        : { error: ocr.error },
    };
  }

  return {
    ...vision,
    ocr: ocr.text
      ? { textPreview: ocr.text, confidence: ocr.confidence, error: ocr.error }
      : { error: ocr.error },
  };
}

function getScanConfig() {
  return {
    ocr: scanOcr.getOcrConfig(),
    vision: scanVision.getPublicConfig(),
    visionFallback: visionFallbackEnabled(),
  };
}

module.exports = {
  scanTicketFromImage,
  getScanConfig,
  getUsageStats: scanVision.getUsageStats,
};
