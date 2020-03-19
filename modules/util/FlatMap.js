/**
 * Map a list to an array of arrays, and return the flattened result.
 * @param {Array<*>|Set<*>|Map<*>} list
 * @param {function(*): Array<*>} mapFn
 * @returns Array<*>
 */
export function flatMap(list, mapFn) {
    const listArray = list instanceof Map || list instanceof Set
        ? Array.from(list.values())
        : list;

    return listArray.reduce((flattened, item)=> {
        const mapped = mapFn(item);

        return flattened.concat(mapped);
    }, []);
}
