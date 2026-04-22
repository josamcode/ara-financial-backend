'use strict';

const { v2: cloudinary } = require('cloudinary');
const { AppError } = require('../common/errors');

let isConfigured = false;

function ensureCloudinaryConfigured() {
  if (isConfigured) return;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary is not configured');
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });

  isConfigured = true;
}

function mapCloudinaryError(error) {
  const providerMessage =
    error?.error?.message ||
    error?.message ||
    'Cloudinary request failed';

  const normalizedMessage = String(providerMessage).toLowerCase();

  if (
    normalizedMessage.includes('disabled customer') ||
    normalizedMessage.includes('cloud_name is disabled')
  ) {
    return new AppError(
      'Cloudinary account is disabled. Replace CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET with an active account.',
      502,
      'CLOUDINARY_DISABLED'
    );
  }

  if (error?.http_code === 401 || normalizedMessage.includes('invalid')) {
    return new AppError(
      'Cloudinary credentials are invalid. Update CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
      502,
      'CLOUDINARY_AUTH_FAILED'
    );
  }

  return new AppError(
    `Cloudinary request failed: ${providerMessage}`,
    502,
    'CLOUDINARY_ERROR'
  );
}

async function uploadTenantLogo({ tenantId, file }) {
  ensureCloudinaryConfigured();

  try {
    const uploadResponse = await cloudinary.uploader.upload(
      `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
      {
        folder: `ara-financial/tenants/${tenantId}/branding`,
        resource_type: 'image',
      }
    );

    return uploadResponse.secure_url;
  } catch (error) {
    throw mapCloudinaryError(error);
  }
}

function extractPublicIdFromUrl(assetUrl) {
  if (!assetUrl) return null;

  try {
    const parsedUrl = new URL(assetUrl);
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    const uploadIndex = pathSegments.findIndex((segment) => segment === 'upload');

    if (uploadIndex === -1) return null;

    const afterUploadSegments = pathSegments.slice(uploadIndex + 1);
    const versionIndex = afterUploadSegments.findIndex((segment) => /^v\d+$/.test(segment));
    const publicIdSegments =
      versionIndex >= 0 ? afterUploadSegments.slice(versionIndex + 1) : afterUploadSegments;

    if (!publicIdSegments.length) return null;

    const lastSegmentIndex = publicIdSegments.length - 1;
    publicIdSegments[lastSegmentIndex] = publicIdSegments[lastSegmentIndex].replace(/\.[^.]+$/, '');

    return publicIdSegments.join('/');
  } catch {
    return null;
  }
}

async function deleteTenantLogo(assetUrl) {
  const publicId = extractPublicIdFromUrl(assetUrl);
  if (!publicId) return false;

  ensureCloudinaryConfigured();
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
      invalidate: true,
    });
  } catch (error) {
    throw mapCloudinaryError(error);
  }

  return true;
}

module.exports = {
  deleteTenantLogo,
  uploadTenantLogo,
};
