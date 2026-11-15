import { importLibrary, setOptions } from '@googlemaps/js-api-loader'

// Loads the Maps libraries exactly once per page lifetime. React StrictMode
// remounts effects in dev, and a second setOptions() call is ignored with a
// warning, so the module-level cache keeps the second mount quiet.
let mapsLib: Promise<{ Map: typeof google.maps.Map }> | null = null

export function loadMaps(apiKey: string) {
  if (!mapsLib) {
    setOptions({ key: apiKey, v: 'weekly' })
    mapsLib = importLibrary('maps')
  }
  return mapsLib
}
