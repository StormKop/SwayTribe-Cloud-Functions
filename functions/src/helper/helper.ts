type Environment = 'DEV' | 'PROD'

export function environment(): Environment {
  if (process.env.FUNCTIONS_EMULATOR == 'true') {
    return 'DEV'
  } else {
    return 'PROD'
  }
}