import { DefaultNamingStrategy } from 'typeorm';

function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/** Converts inferred column and join-column names to snake_case. */
export class SnakeNamingStrategy extends DefaultNamingStrategy {
  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    return (
      customName ?? toSnakeCase([...embeddedPrefixes, propertyName].join('_'))
    );
  }

  override joinColumnName(
    relationName: string,
    referencedColumnName: string,
  ): string {
    return toSnakeCase(`${relationName}_${referencedColumnName}`);
  }
}
