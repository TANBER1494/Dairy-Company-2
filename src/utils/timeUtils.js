// src/utils/timeUtils.js
/**
 * @returns {string} 'MORNING' or 'EVENING'
 */
const getCurrentShift = () => {
  const currentHour = parseInt(
    new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo", hour: '2-digit', hour12: false })
  );
  return (currentHour >= 4 && currentHour < 16) ? 'MORNING' : 'EVENING';
};

module.exports = { getCurrentShift };