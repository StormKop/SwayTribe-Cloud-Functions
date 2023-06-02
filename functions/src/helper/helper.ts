type Environment = 'DEV' | 'PROD'

export const environment = (): Environment => {
  if (process.env.FUNCTIONS_EMULATOR == 'true') {
    return 'DEV'
  } else {
    return 'PROD'
  }
}