import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from './db';
import { games, categories, publishers } from '../../db/schema';
import type { Category, Game, Publisher } from '../types/game';

export interface GameFilters {
    categoryIds?: number[] | number;
    categoryId?: number[] | number;
    publisherIds?: number[] | number;
    publisherId?: number[] | number;
}

const gameSelection = {
    id: games.id,
    title: games.title,
    description: games.description,
    starRating: games.starRating,
    categoryId: categories.id,
    categoryName: categories.name,
    publisherId: publishers.id,
    publisherName: publishers.name,
};

type GameSelectionRow = {
    id: number;
    title: string;
    description: string;
    starRating: number | null;
    categoryId: number | null;
    categoryName: string | null;
    publisherId: number | null;
    publisherName: string | null;
};

function mapGame(row: GameSelectionRow): Game {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        starRating: row.starRating,
        category:
            row.categoryId !== null && row.categoryName !== null
                ? { id: row.categoryId, name: row.categoryName }
                : null,
        publisher:
            row.publisherId !== null && row.publisherName !== null
                ? { id: row.publisherId, name: row.publisherName }
                : null,
    };
}

function normalizeFilterValues(values: number[] | number | undefined): number[] {
    if (values === undefined) {
        return [];
    }

    const list = Array.isArray(values) ? values : [values];
    return [...new Set(list.filter((value) => Number.isInteger(value) && value > 0))];
}

function resolveFilters(filters: GameFilters = {}): { categoryIds: number[]; publisherIds: number[] } {
    const categoryIds = normalizeFilterValues(filters.categoryIds ?? filters.categoryId);
    const publisherIds = normalizeFilterValues(filters.publisherIds ?? filters.publisherId);

    return { categoryIds, publisherIds };
}

function baseGamesQuery(db: Database) {
    return db
        .select(gameSelection)
        .from(games)
        .leftJoin(categories, eq(games.categoryId, categories.id))
        .leftJoin(publishers, eq(games.publisherId, publishers.id));
}

/** All games ordered by title, optionally narrowed to one or more category and/or publisher filters. */
export async function getAllGames(db: Database, filters: GameFilters = {}): Promise<Game[]> {
    const { categoryIds, publisherIds } = resolveFilters(filters);
    const conditions = [];

    if (categoryIds.length > 0) {
        conditions.push(inArray(games.categoryId, categoryIds));
    }

    if (publisherIds.length > 0) {
        conditions.push(inArray(games.publisherId, publisherIds));
    }

    if (conditions.length > 0) {
        const rows = await baseGamesQuery(db).where(and(...conditions)).orderBy(asc(games.title));
        return rows.map(mapGame);
    }

    const rows = await baseGamesQuery(db).orderBy(asc(games.title));
    return rows.map(mapGame);
}

/** All game ids ordered by title, optionally narrowed by the same filters as the list view. */
export async function getAllGameIds(db: Database, filters: GameFilters = {}): Promise<number[]> {
    const { categoryIds, publisherIds } = resolveFilters(filters);
    const conditions = [];

    if (categoryIds.length > 0) {
        conditions.push(inArray(games.categoryId, categoryIds));
    }

    if (publisherIds.length > 0) {
        conditions.push(inArray(games.publisherId, publisherIds));
    }

    if (conditions.length > 0) {
        const rows = await db.select({ id: games.id }).from(games).where(and(...conditions)).orderBy(asc(games.title));
        return rows.map((row) => row.id);
    }

    const rows = await db.select({ id: games.id }).from(games).orderBy(asc(games.title));
    return rows.map((row) => row.id);
}

/** All categories ordered by name for filter controls and listing badges. */
export async function getAllCategories(db: Database): Promise<Category[]> {
    const rows = await db.select({ id: categories.id, name: categories.name }).from(categories).orderBy(asc(categories.name));
    return rows;
}

/** All publishers ordered by name for filter controls and listing badges. */
export async function getAllPublishers(db: Database): Promise<Publisher[]> {
    const rows = await db
        .select({ id: publishers.id, name: publishers.name })
        .from(publishers)
        .orderBy(asc(publishers.name));
    return rows;
}

/** A single game by id, or null when it does not exist. */
export async function getGameById(db: Database, id: number): Promise<Game | null> {
    const row = await baseGamesQuery(db).where(eq(games.id, id)).get();
    return row ? mapGame(row) : null;
}
