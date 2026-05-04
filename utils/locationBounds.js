const JHANG_CENTER = {
  latitude: 31.2681,
  longitude: 72.3181,
};

const JHANG_ALLOWED_RADIUS_KM = 70;

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const distanceKm = (lat1, lng1, lat2, lng2) => {
  const earthRadiusKm = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const isValidCoordinate = (latitude, longitude) => {
  const lat = toNumber(latitude);
  const lng = toNumber(longitude);
  if (lat === null || lng === null) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return !(lat === 0 && lng === 0);
};

const isWithinJhang = (latitude, longitude) => {
  if (!isValidCoordinate(latitude, longitude)) return false;
  return distanceKm(
    Number(latitude),
    Number(longitude),
    JHANG_CENTER.latitude,
    JHANG_CENTER.longitude
  ) <= JHANG_ALLOWED_RADIUS_KM;
};

module.exports = {
  JHANG_ALLOWED_RADIUS_KM,
  JHANG_CENTER,
  isValidCoordinate,
  isWithinJhang,
};
