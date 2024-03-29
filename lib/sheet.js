const Spreadsheet = require('./spreadsheet')

class Sheet {
  constructor (options) {
    this.options = { ...options }
    this.spreadsheet = new Spreadsheet(this.options)
  }

  /**
   * Get raw
   * @param {String} options
   * @returns
   */
  async raw (options) {
    return this.spreadsheet.load(options)
  }

  /**
   * Insert new row with json data
   *
   * @param {Object|Array} data
   */
  async insert (data) {
    const header = await this.getHeader()
    const addHeaders = []
    const values = []
    data = Array.isArray(data) ? data : [data]

    data.forEach(item => {
      // eslint-disable-next-line no-array-constructor
      const value = new Array()
      Object.keys(item).forEach(key => {
        let index = header.indexOf(key)
        if (index === -1) {
          addHeaders.push(key)
          index = header.push(key) - 1
        }
        value[index] = item[key]
      })
      values.push(value)
    })

    if (addHeaders.length) {
      await this.updateHeader(header)
    }

    const ret = await this.spreadsheet.append({ data: values, sheet: this.options.sheet })
    values.unshift(header)
    return this.valuesToData(values, { startRow: ret.startRow })
  }

  /**
   * Update rows that matched the query
   *
   * @param {Object|null} query
   * @param {Object} update
   */
  async update (query, update) {
    const data = await this.find(query, { header: 1 })
    const header = data._header
    const updateData = []
    data.forEach(item => {
      const line = {}
      let row = item._row

      Object.keys(update).forEach(key => {
        const index = header.indexOf(key) + 1
        const value = update[key]
        const orgValue = item[key] || ''
        if (typeof value === 'string') {
          line[index] = value
        } else if (typeof value === 'number') {
          line[index] = String(value)
        } else if (typeof value === 'object') {
          Object.keys(value).forEach(k => {
            const v = value[k]
            switch (k) {
              case '$inc':
                line[index] = String(parseInt(v) + ((typeof orgValue === 'number' || /^\d+$/.test(orgValue)) ? parseInt(orgValue) : 0))
                break
              case '$append':
                line[index] = orgValue + String(v)
                break
              case '$prepend':
                line[index] = String(v) + orgValue
                break
              case '$lowercase':
                line[index] = orgValue.toLowerCase()
                break
              case '$uppercase':
                line[index] = orgValue.toUpperCase()
                break
              case '$replace':
                line[index] = orgValue.replace(new RegExp(Object.keys(v).join('|'), 'g'), (mv) => v[mv])
                break
            }
          })
        }
      })

      !updateData.some(i => i.row === row) && updateData.push({ row, data: line })
    })
    return this.spreadsheet.update({ data: updateData, sheet: this.options.sheet })
  }

  /**
   * Delete rows that matched the query
   *
   * @param {Object} query
   */
  async delete (query) {
    if (!query) throw new Error('no query specified')
    const rows = (await this.find(query)).map(item => item._row)
    return this.spreadsheet.delete({ rows, sheet: this.options.sheet })
  }

  /**
   * Find rows that matched the query
   *
   * @param {Object|null} query
   * @param {Object|null} options
   */
  async find (query, options) {
    const values = await this.spreadsheet.list({ sheet: this.options.sheet, ...options })
    const data = this.valuesToData(values, options)
    return this.filterData(data, query, options)
  }

  /**
   * Find one row that matched the query
   *
   * @param {Object} query
   * @param {Object} options
   */
  async findOne (query, options) {
    return (await this.find(query, { ...options, limit: 1 })).pop()
  }

  /**
   * Get headers
   */
  async getHeader () {
    const values = await this.spreadsheet.list({ sheet: this.options.sheet, limit: 1 })
    return values[0] || []
  }

  /**
   * Update header
   *
   * @param {Array} header
   */
  async updateHeader (header) {
    return this.spreadsheet.update({ data: { 1: header }, sheet: this.options.sheet })
  }

  /**
   * Filter data
   *
   * @param {Array} data
   * @param {Object} query
   * @param {Object} options
   */
  filterData (data, query, options) {
    if (!data.length) return data
    query = query || {}
    const { skip = 0, limit = 0, sort } = options || {}
    const filterFn = this.buildFilterFn(query)
    const sortFn = this.buildSortFn(sort)
    const header = data._header
    let result = data.filter(filterFn)
    if (sortFn) result.sort(sortFn)
    if (skip > 0 || limit > 0) result = result.slice(skip, skip + limit)
    if (header) result._header = header
    return result
  }

  /**
   *
   * @param {Object} query
   */
  buildFilterFn (query) {
    const filter = this.buildFilter(query)
    return function (item) {
      return !filter.some(f => {
        const { key, type, value } = f
        const itemValue = item[key]

        switch (type) {
          case 'string':
            return String(itemValue) !== String(value)
          case 'pattern':
            return !value.test(itemValue)
          case 'contains':
            return !itemValue.includes(value)
          case 'gt':
            return parseInt(itemValue) <= value
          case 'lt':
            return parseInt(itemValue) >= value
          case 'gte':
            return parseInt(itemValue) < value
          case 'lte':
            return parseInt(itemValue) > value
          case 'empty':
            return value ? !!itemValue : !itemValue
          case 'function':
            return !value(itemValue)
          default:
            return false
        }
      })
    }
  }

  /**
   * Build sort function to sort the rows
   *
   * @param {Object} sort
   */
  buildSortFn (sort) {
    if (!sort || !Object.keys(sort).length) return
    return function (a, b) {
      for (let key in sort) {
        let av = a[key]
        let bv = b[key]
        const desc = sort[key] < 0
        let compareType = null
        if ((/^\d+$/.test(av) && /^\d+$/.test(bv)) || (typeof av === 'number' && typeof bv === 'number')) {
          compareType = 'number'
          if (typeof av !== 'number') av = parseInt(av)
          if (typeof bv !== 'number') bv = parseInt(bv)
        }
        let n = compareType === 'number' ? av - bv : av.localeCompare(bv)
        if (desc && n !== 0) n = n > 0 ? -1 : 1
        if (n !== 0) return n
      }
      return 0
    }
  }

  /**
   * Build filter terms to filter
   *
   * @param {Object} query
   */
  buildFilter (query) {
    const terms = []
    if (!query) return terms
    Object.keys(query).forEach(key => {
      const term = query[key]
      if (typeof term === 'string') {
        if (term.includes('*')) {
          terms.push({
            key,
            type: 'pattern',
            value: new RegExp('^' + term.replace(/\*/g, '(.*?)') + '$')
          })
        } else {
          terms.push({
            key,
            type: 'string',
            value: term
          })
        }
      } else if (typeof term === 'function') {
        terms.push({
          key,
          type: 'function',
          value: term
        })
      } else if (term instanceof RegExp) {
        terms.push({
          key,
          type: 'pattern',
          value: term
        })
      } else if (typeof term === 'object') {
        Object.keys(term).forEach(op => {
          const value = term[op]
          switch (op) {
            case '$contains':
              terms.push({
                key,
                type: 'contains',
                value
              })
              break
            case '$gt':
              terms.push({
                key,
                type: 'gt',
                value
              })
              break
            case '$lt':
              terms.push({
                key,
                type: 'lt',
                value
              })
              break
            case '$lte':
              terms.push({
                key,
                type: 'lte',
                value
              })
              break
            case '$gte':
              terms.push({
                key,
                type: 'gte',
                value
              })
              break
            case '$empty':
              terms.push({
                key,
                type: 'empty',
                value
              })
              break
          }
        })
      } else {
        terms.push({
          key,
          type: 'string',
          value: String(term)
        })
      }
    })
    return terms
  }

  /**
   * Convert values to json data
   *
   * @param {Array} values
   * @param {Object} options
   */
  valuesToData (values, options) {
    const { startRow, column, lowercase, header: includeHeader } = options || {}
    if (!values || !values[0]) return []
    const header = values[0].map(v => lowercase && v ? v.toLowerCase() : v)
    const data = []
    values.forEach((value, i) => {
      if (i === 0 || value.join('') === '') return
      const json = { _row: startRow ? startRow + i - 1 : i + 1 }
      value.forEach((v, j) => {
        const h = header[j]
        if (h) json[h] = v || ''
        if (column) json[this.columnToLetter(j + 1)] = v || ''
      })
      data.push(json)
    })
    if (includeHeader) data._header = header
    return data
  }

  /**
   * Convert column index to letter
   *
   * @param {Number} column
   */
  columnToLetter (column) {
    let temp; let letter = ''
    while (column > 0) {
      temp = (column - 1) % 26
      letter = String.fromCharCode(temp + 65) + letter
      column = (column - temp - 1) / 26
    }
    return letter
  }
}

module.exports = Sheet
