// Sleeps for requested time in seconds
const sleepInSeconds = seconds =>
  new Promise(resolve => setTimeout(resolve, seconds * 1000))

// Returns a string representation of provided data
const str = data => {
  return JSON.stringify(data, null, 2)
}

module.exports = { sleepInSeconds, str }
