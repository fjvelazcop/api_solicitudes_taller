import { Sequelize, Options } from 'sequelize';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';

dotenv.config();

const require = createRequire(import.meta.url);
const sqliteBridge = require('./sqliteBridge.cjs');

// Configuración predeterminada para el servidor Profit MSSQL AD_TRANS
const profitHost = process.env.PROFIT_DB_HOST || 'SRVBDPROFITBK';
const profitPort = parseInt(process.env.PROFIT_DB_PORT || '1433', 10);
const profitDbName = process.env.PROFIT_DB_NAME || 'AD_TRANS';
const profitUser = process.env.PROFIT_DB_USER || 'fvelazco';
const profitPassword = process.env.PROFIT_DB_PASSWORD || '123';
const profitDialect = (process.env.PROFIT_DB_DIALECT || 'mssql').toLowerCase() as 'mssql' | 'sqlite';

let profitSequelizeConfig: Options;
let isFallbackMode = false;

const shouldLogProfitSql = process.env.DEBUG_SQL === 'true';

if (profitDialect === 'mssql') {
  profitSequelizeConfig = {
    dialect: 'mssql',
    host: profitHost,
    port: profitPort,
    database: profitDbName,
    username: profitUser,
    password: profitPassword,
    logging: shouldLogProfitSql ? (msg) => logger.debug(`[Profit MSSQL AD_TRANS] ${msg}`) : false,
    dialectOptions: {
      options: {
        encrypt: false,
        trustServerCertificate: true,
        connectTimeout: 5000,
        requestTimeout: 10000,
      },
    },
    pool: {
      max: 10,
      min: 0,
      acquire: 15000,
      idle: 10000,
    },
  };
} else {
  const dir = path.resolve(process.cwd(), './data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  profitSequelizeConfig = {
    dialect: 'sqlite',
    dialectModule: sqliteBridge,
    storage: path.resolve(process.cwd(), './data/profit_ad_trans.sqlite'),
    logging: shouldLogProfitSql ? (msg) => logger.debug(`[Profit SQLite Fallback] ${msg}`) : false,
  };
}

export let profitSequelize = new Sequelize(profitSequelizeConfig);

/**
 * Espejo local SQLite de las tablas Profit AD_TRANS.
 *
 * Esta conexión SIEMPRE apunta a ./data/profit_ad_trans.sqlite, exista o no MSSQL.
 * Sirve como caché y cola de operaciones para escenarios offline-first:
 * - Permite que la aplicación responda a /api/v1/profit/* aun sin MSSQL.
 * - Recibe las inserciones/actualizaciones que la sincronización bidireccional
 *   descarga desde MSSQL.
 * - Mantiene la disponibilidad cuando la red al servidor Profit Plus se cae.
 *
 * El sincronizador (MasterSyncService) se encarga de:
 *   1. poblar este espejo desde MSSQL al arrancar,
 *   2. mantenerlo actualizado cada 30s,
 *   3. propagar hacia MSSQL cualquier cambio local.
 */
const profitMirrorDir = path.resolve(process.cwd(), './data');
if (!fs.existsSync(profitMirrorDir)) fs.mkdirSync(profitMirrorDir, { recursive: true });

export const profitMirrorSequelize = new Sequelize({
  dialect: 'sqlite',
  dialectModule: sqliteBridge,
  storage: path.resolve(process.cwd(), './data/profit_ad_trans.sqlite'),
  logging: shouldLogProfitSql ? (msg) => logger.debug(`[Profit Mirror SQLite] ${msg}`) : false,
});

/**
 * Asegura que el espejo SQLite posea las mismas tablas que la conexión MSSQL
 * de Profit AD_TRANS. Se ejecuta en el arranque, antes del primer ciclo
 * de sincronización maestra, para evitar errores de "tabla inexistente".
 */
export async function initProfitMirrorSchema(): Promise<void> {
  try {
    await profitMirrorSequelize.authenticate();

    // El espejo se maneja con queries crudas en el MasterSyncService.
    // Aquí solo creamos las tablas (sin `sync({alter})` para evitar locks).

    await profitMirrorSequelize.query(`
      CREATE TABLE IF NOT EXISTS mecanicos (
        codigo TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        cargo TEXT,
        activo INTEGER DEFAULT 1
      );
    `);

    await profitMirrorSequelize.query(`
      CREATE TABLE IF NOT EXISTS vw_flota_vendedores (
        co_ven TEXT PRIMARY KEY,
        cedula TEXT,
        ven_des TEXT
      );
    `);

    await profitMirrorSequelize.query(`
      CREATE TABLE IF NOT EXISTS vw_flota_articulos (
        codigo_profit TEXT PRIMARY KEY,
        nombre_producto TEXT NOT NULL,
        codigo_categoria TEXT,
        categoria TEXT,
        unidad_medida TEXT,
        costo REAL DEFAULT 0,
        tipo TEXT,
        codigo_subalmacen TEXT,
        sub_almacen TEXT,
        codigo_almacen TEXT,
        almacen TEXT,
        stock_act REAL DEFAULT 0
      );
    `);

    await profitMirrorSequelize.query(`
      CREATE TABLE IF NOT EXISTS flota_ordenes_servicio (
        id_orden INTEGER PRIMARY KEY AUTOINCREMENT,
        nro_orden TEXT NOT NULL UNIQUE,
        Placa TEXT NOT NULL,
        km_horometro REAL NOT NULL,
        recibido_por TEXT NOT NULL,
        entregado_por TEXT,
        fec_apertura DATETIME DEFAULT CURRENT_TIMESTAMP,
        fec_cierre DATETIME,
        sintomas_reportados TEXT NOT NULL,
        es_reincidencia INTEGER DEFAULT 0,
        nro_orden_anterior TEXT,
        motivo_reincidencia TEXT,
        fotos_adjuntas INTEGER DEFAULT 0,
        estatus TEXT DEFAULT 'ABIERTA',
        costo_repuestos REAL DEFAULT 0,
        costo_mano_obra REAL DEFAULT 0,
        costo_servicios_ext REAL DEFAULT 0,
        costo_total REAL DEFAULT 0,
        recibe_conforme TEXT,
        hora_apertura DATETIME,
        hora_cierre DATETIME
      );
    `);

    logger.info(`[Profit Mirror] Esquema SQLite espejo listo (./data/profit_ad_trans.sqlite).`);
  } catch (err: any) {
    logger.error(`[Profit Mirror] No se pudo inicializar el esquema SQLite espejo: ${err.message}`);
  }
}

/**
 * Copia los datos actualmente presentes en `profitSequelize` (la conexión principal,
 * sea MSSQL o el fallback SQLite) hacia `profitMirrorSequelize` (espejo local).
 *
 * Se ejecuta tras `initProfitMirrorSchema()` en el arranque del servidor para
 * garantizar que el espejo local posea datos útiles desde el primer ciclo,
 * incluso en escenarios offline-first donde MSSQL no esté disponible.
 *
 * Estrategia: usa `INSERT OR IGNORE` (SQLite) para no duplicar si ya existieran.
 */
export async function seedProfitMirrorFromMain(): Promise<void> {
  try {
    // Solo tiene sentido cuando `profitSequelize` también es SQLite (modo fallback).
    // En modo MSSQL real, la descarga la hace `MasterSyncService` desde el servidor remoto.
    if (profitSequelize.getDialect() !== 'sqlite') {
      logger.info(`[Profit Mirror] Modo MSSQL activo. El espejo se poblará desde el servidor remoto vía MasterSyncService.`);
      return;
    }

    const tables: Array<{ table: string; pk: string; cols: string[] }> = [
      { table: 'mecanicos', pk: 'codigo', cols: ['codigo', 'nombre', 'cargo', 'activo'] },
      { table: 'vw_flota_vendedores', pk: 'co_ven', cols: ['co_ven', 'cedula', 'ven_des'] },
      { table: 'vw_flota_articulos', pk: 'codigo_profit', cols: ['codigo_profit', 'nombre_producto', 'codigo_categoria', 'categoria', 'unidad_medida', 'costo', 'tipo', 'codigo_subalmacen', 'sub_almacen', 'codigo_almacen', 'almacen', 'stock_act'] },
    ];

    for (const t of tables) {
      const [rows]: any = await profitSequelize.query(`SELECT ${t.cols.join(', ')} FROM ${t.table}`);
      if (!rows || rows.length === 0) continue;

      // INSERT OR IGNORE en SQLite preserva filas existentes.
      for (const row of rows) {
        const placeholders = t.cols.map(() => '?').join(', ');
        const values = t.cols.map((c) => row[c]);
        await profitMirrorSequelize.query(
          `INSERT OR IGNORE INTO ${t.table} (${t.cols.join(', ')}) VALUES (${placeholders})`,
          { replacements: values }
        );
      }
      logger.info(`[Profit Mirror] ${rows.length} registros copiados a espejo.${t.table}`);
    }
  } catch (err: any) {
    logger.warn(`[Profit Mirror] No se pudo copiar el contenido inicial al espejo: ${err.message}`);
  }
}

/**
 * Prueba y obtiene el estado detallado de la conexión MSSQL al servidor Profit (AD_TRANS)
 */
export async function getProfitConnectionStatus(): Promise<{
  connected: boolean;
  server: string;
  database: string;
  user: string;
  dialect: string;
  fallback: boolean;
  message: string;
  latencyMs?: number;
}> {
  const start = Date.now();
  try {
    await profitSequelize.authenticate();
    const latency = Date.now() - start;
    return {
      connected: true,
      server: isFallbackMode ? 'Local SQLite Emulado' : profitHost,
      database: profitDbName,
      user: profitUser,
      dialect: profitSequelize.getDialect().toUpperCase(),
      fallback: isFallbackMode,
      latencyMs: latency,
      message: `Conexión activa y autenticada con ${isFallbackMode ? 'fallback SQLite' : 'MSSQL ' + profitHost}`,
    };
  } catch (error: any) {
    return {
      connected: false,
      server: profitHost,
      database: profitDbName,
      user: profitUser,
      dialect: 'MSSQL',
      fallback: isFallbackMode,
      message: `Error de conexión: ${error.message || error}`,
    };
  }
}

/**
 * Indica si la conexión activa con el servidor Profit es **realmente MSSQL**.
 * Retorna `true` solo cuando NO estamos en modo fallback (es decir,
 * `profitSequelize` apunta a un servidor Microsoft SQL Server remoto).
 */
export function isMssqlConnectionActive(): boolean {
  try {
    return profitSequelize.getDialect() === 'mssql' && !isFallbackMode;
  } catch {
    return false;
  }
}

/**
 * Inicializa la conexión MSSQL con Profit Plus (AD_TRANS)
 * Si el servidor SRVBDPROFITBK no está accesible (ej. desarrollo fuera de la red local),
 * conmuta automáticamente a almacenamiento local SQLite para no interrumpir el desarrollo.
 */
export async function initProfitDatabase(): Promise<Sequelize> {
  try {
    await profitSequelize.authenticate();
    logger.info(`[Profit MSSQL] Conectado exitosamente a ${profitHost}/${profitDbName} con usuario ${profitUser}`);
    return profitSequelize;
  } catch (err: any) {
    if (profitDialect === 'mssql') {
      logger.warn(`[Profit MSSQL] No se pudo conectar a ${profitHost}/${profitDbName} (${err.message}). Activando respaldo local SQLite para desarrollo.`);
      isFallbackMode = true;

      const fallbackDir = path.resolve(process.cwd(), './data');
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }

      profitSequelize = new Sequelize({
        dialect: 'sqlite',
        dialectModule: sqliteBridge,
        storage: path.resolve(process.cwd(), './data/profit_ad_trans.sqlite'),
        logging: false,
      });

      await profitSequelize.authenticate();
      await seedProfitFallbackTables(profitSequelize);

      // Re-vincular modelos Sequelize a la instancia fallback
      const { initFlotaOrdenServicioProfitModel } = await import('../models/FlotaOrdenServicioProfit.model');
      const { initVwFlotaVendedoresModel } = await import('../models/VwFlotaVendedores.model');
      const { initVwFlotaArticulosModel } = await import('../models/VwFlotaArticulos.model');
      const { initMecanicosProfitModel } = await import('../models/MecanicosProfit.model');
      initFlotaOrdenServicioProfitModel(profitSequelize);
      initVwFlotaVendedoresModel(profitSequelize);
      initVwFlotaArticulosModel(profitSequelize);
      initMecanicosProfitModel(profitSequelize);

      logger.info(`[Profit MSSQL] Respaldo local SQLite para AD_TRANS inicializado exitosamente.`);
      return profitSequelize;
    }
    logger.error(`[Profit DB] Error al inicializar:`, err);
    throw err;
  }
}

/**
 * Crea tablas y datos iniciales en la base de datos de respaldo SQLite
 * para simular las vistas y tablas de Profit AD_TRANS en entornos de desarrollo local.
 */
async function seedProfitFallbackTables(seq: Sequelize): Promise<void> {
  try {
    await seq.query(`
      CREATE TABLE IF NOT EXISTS flota_ordenes_servicio (
        id_orden INTEGER PRIMARY KEY AUTOINCREMENT,
        nro_orden TEXT NOT NULL UNIQUE,
        Placa TEXT NOT NULL,
        km_horometro REAL NOT NULL,
        recibido_por TEXT NOT NULL,
        entregado_por TEXT,
        fec_apertura DATETIME DEFAULT CURRENT_TIMESTAMP,
        fec_cierre DATETIME,
        sintomas_reportados TEXT NOT NULL,
        es_reincidencia INTEGER DEFAULT 0,
        nro_orden_anterior TEXT,
        motivo_reincidencia TEXT,
        fotos_adjuntas INTEGER DEFAULT 0,
        estatus TEXT DEFAULT 'ABIERTA',
        costo_repuestos REAL DEFAULT 0,
        costo_mano_obra REAL DEFAULT 0,
        costo_servicios_ext REAL DEFAULT 0,
        costo_total REAL DEFAULT 0,
        recibe_conforme TEXT,
        hora_apertura DATETIME,
        hora_cierre DATETIME
      );
    `);

    await seq.query(`
      CREATE TABLE IF NOT EXISTS vw_flota_vendedores (
        co_ven TEXT PRIMARY KEY,
        cedula TEXT,
        ven_des TEXT
      );
    `);

    await seq.query(`
      CREATE TABLE IF NOT EXISTS vw_flota_articulos (
        codigo_profit TEXT PRIMARY KEY,
        nombre_producto TEXT NOT NULL,
        codigo_categoria TEXT,
        categoria TEXT,
        unidad_medida TEXT,
        costo REAL DEFAULT 0,
        tipo TEXT,
        codigo_subalmacen TEXT,
        sub_almacen TEXT,
        codigo_almacen TEXT,
        almacen TEXT,
        stock_act REAL DEFAULT 0
      );
    `);

    await seq.query(`
      CREATE TABLE IF NOT EXISTS mecanicos (
        codigo TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        cargo TEXT,
        activo INTEGER DEFAULT 1
      );
    `);

    // Sembrar Vendedores si está vacía
    const [vendedores]: any = await seq.query(`SELECT COUNT(*) as count FROM vw_flota_vendedores`);
    if (vendedores[0]?.count === 0) {
      
      logger.info(`[Profit SQLite Fallback] 8 vendedores de prueba sembrados en vw_flota_vendedores`);
    }

    // Sembrar Artículos si está vacía
    const [articulos]: any = await seq.query(`SELECT COUNT(*) as count FROM vw_flota_articulos`);
    if (articulos[0]?.count === 0) {
   
      logger.info(`[Profit SQLite Fallback] Artículos de prueba sembrados en vw_flota_articulos`);
    }

    // Sembrar Mecánicos con los 19 registros oficiales
    const [mecanicosCount]: any = await seq.query(`SELECT COUNT(*) as count FROM mecanicos`);
    const [hasNewData]: any = await seq.query(`SELECT COUNT(*) as count FROM mecanicos WHERE codigo LIKE 'V%'`);
    if (mecanicosCount[0]?.count === 0 || hasNewData[0]?.count === 0) {
      await seq.query(`DELETE FROM mecanicos;`);
     
      logger.info(`[Profit SQLite Fallback] 19 mecánicos oficiales sembrados en ad_trans.dbo.mecanicos`);
    }

    // Sembrar Órdenes de Servicio de flota si está vacía (para sincronización bidireccional)
    const [ordenesCount]: any = await seq.query(`SELECT COUNT(*) as count FROM flota_ordenes_servicio`);
    if (ordenesCount[0]?.count === 0) {
    
      logger.info(`[Profit SQLite Fallback] 3 órdenes de flota de prueba sembradas en flota_ordenes_servicio`);
    }
  } catch (err: any) {
    logger.warn(`[Profit SQLite Fallback] Error sembrando tablas de respaldo: ${err.message}`);
  }
}


export default profitSequelize;
