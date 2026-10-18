// Configuración embebida en el build: valores públicos del entorno y contratos del sistema fijados (validados al
// cargar el módulo: un archivo mal formado impide arrancar).
import config from 'virtual:mtw-config';
import systemContractsFile from 'virtual:mtw-system-contracts';
import { parseSystemContracts } from './system-contracts.ts';

export const appConfig = config;
export const systemContracts = parseSystemContracts(systemContractsFile);
