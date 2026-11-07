/** RahBaz product identity for side-by-side installs with T3 Code. */

export const PRODUCT_HOME_DIR_NAME = ".rahbaz";
export const DESKTOP_APP_ID = "com.rahbaz.client";
export const DESKTOP_UPDATE_REPOSITORY_DEFAULT = "Farhadrzi/rahbaz-client";

const PRODUCT_HOME_ENV = "RAHBAZ_HOME";
const LEGACY_PRODUCT_HOME_ENV = "T3CODE_HOME";

export function resolveConfiguredProductHome(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const key of [PRODUCT_HOME_ENV, LEGACY_PRODUCT_HOME_ENV] as const) {
    const raw = env[key]?.trim();
    if (raw) return raw;
  }
  return undefined;
}

export function defaultProductHome(
  homeDirectory: string,
  joinPath: (...parts: string[]) => string,
): string {
  return joinPath(homeDirectory, PRODUCT_HOME_DIR_NAME);
}
