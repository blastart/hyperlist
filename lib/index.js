/* global CustomEvent */

const defaultConfig = {
  width: '100%',
  height: '100%'
}

// Check for valid number.
const isNumber = input => Number(input) === Number(input)

/**
 * Creates a HyperList instance that virtually scrolls very large amounts of
 * data effortlessly.
 */
export default class HyperList {
  static create (element, userProvidedConfig) {
    return new HyperList(element, userProvidedConfig)
  }

  constructor (element, userProvidedConfig) {
    this._config = {}
    this._lastRepaint = null

    this.refresh(element, userProvidedConfig)

    const config = this._config

    // Create internal render loop.
    const render = () => {
      const scrollTop = this._getScrollPosition()
      const lastRepaint = this._lastRepaint

      if (scrollTop === lastRepaint) {
        return
      }

      const diff = lastRepaint ? scrollTop - lastRepaint : 0
      if (!lastRepaint || diff < 0 || diff > this._averageHeight) {
        const rendered = this._renderChunk()

        this._lastRepaint = scrollTop

        if (rendered !== false && typeof config.afterRender === 'function') {
          config.afterRender()
        }
      }
    }

    render()
    this._element.addEventListener('scroll', () => window.requestAnimationFrame(render))
  }

  destroy () {
    window.cancelAnimationFrame(this._renderAnimationFrame)
  }

  goto (i) {
    this._element.scrollTop = this._itemHeights[i] * i
    this._element.dispatchEvent(new CustomEvent('scroll'))
  }

  refresh (element, userProvidedConfig) {
    Object.assign(this._config, defaultConfig, userProvidedConfig)

    if (!element || element.nodeType !== 1) {
      throw new Error('HyperList requires a valid DOM Node container')
    }

    this._element = element

    const config = this._config

    const scroller = this._scroller || config.scroller ||
      document.createElement(config.scrollerTagName || 'tr')

    if (!config.generate) {
      throw new Error('Missing required `generate` function')
    }

    if (!isNumber(config.total)) {
      throw new Error('Invalid required `total` value, expected number')
    }

    if (!Array.isArray(config.itemHeight) && !isNumber(config.itemHeight)) {
      throw new Error(`
        Invalid required \`itemHeight\` value, expected number or array
      `.trim())
    } else if (isNumber(config.itemHeight)) {
      this._itemHeights = Array(config.total).fill(config.itemHeight)
    } else {
      this._itemHeights = config.itemHeight
    }

    // Width and height should be coerced to string representations. Either in
    // `%` or `px`.
    Object.keys(defaultConfig).filter(prop => prop in config).forEach(prop => {
      const value = config[prop]
      const isValueNumber = isNumber(value)

      if (value && typeof value !== 'string' && typeof value !== 'number') {
        const msg = `Invalid optional \`${prop}\`, expected string or number`
        throw new Error(msg)
      } else if (isValueNumber) {
        config[prop] = `${value}px`
      }
    })

    const isHoriz = config.horizontal
    const value = config[isHoriz ? 'width' : 'height']

    if (value) {
      const isValueNumber = isNumber(value)
      const isValuePercent = isValueNumber ? false : value.slice(-1) === '%'
      // Compute the containerHeight as number
      const numberValue = isValueNumber ? value : parseInt(value.replace(/px|%/, ''), 10)
      const innerSize = window[isHoriz ? 'innerWidth' : 'innerHeight']

      if (isValuePercent) {
        this._containerSize = (innerSize * numberValue) / 100
      } else {
        this._containerSize = isValueNumber ? value : numberValue
      }
    }

    const scrollContainer = config.scrollContainer
    const scrollerHeight = config.itemHeight * config.total

    // Decorate the container element with styles that will match
    // the user supplied configuration.
    const elementStyle = {
      width: `${config.width}`,
      height: scrollContainer ? `${scrollerHeight}px` : `${config.height}`,
      overflow: scrollContainer ? 'none' : 'auto',
      position: 'relative'
    }

    Object.assign(element.style, elementStyle)

    if (scrollContainer) {
      config.scrollContainer.style.overflow = 'auto'
    }

    const scrollerStyle = {
      opacity: '0',
      position: 'absolute',
      [isHoriz ? 'height' : 'width']: '1px',
      [isHoriz ? 'width' : 'height']: `${scrollerHeight}px`
    }

    Object.assign(scroller.style, scrollerStyle)

    // Only append the scroller element once.
    if (!this._scroller) {
      element.appendChild(scroller)
    }

    const padding = this._computeScrollPadding()
    this._scrollPaddingBottom = padding.bottom
    this._scrollPaddingTop = padding.top

    // Set the scroller instance.
    this._scroller = scroller
    this._scrollHeight = this._computeScrollHeight()

    // Reuse the item positions if refreshed, otherwise set to empty array.
    this._itemPositions = this._itemPositions || Array(config.total).fill(0)

    // Each index in the array should represent the position in the DOM.
    this._computePositions(0)

    // Render after refreshing. Force render if we're calling refresh manually.
    this._renderChunk(this._lastRepaint !== null)

    if (typeof config.afterRender === 'function') {
      config.afterRender()
    }
  }

  _getRow (i) {
    const config = this._config
    let item = config.generate(i)
    let height = item.height

    if (height !== undefined && isNumber(height)) {
      item = item.element

      // The height isn't the same as predicted, compute positions again
      if (height !== this._itemHeights[i]) {
        this._itemHeights[i] = height
        this._computePositions(i)
        this._scrollHeight = this._computeScrollHeight(i)
      }
    } else {
      height = this._itemHeights[i]
    }

    if (!item || item.nodeType !== 1) {
      throw new Error(`Generator did not return a DOM Node for index: ${i}`)
    }

    item.classList.add(config.rowClassName || 'vrow')

    const top = this._itemPositions[i] + this._scrollPaddingTop

    Object.assign(item.style, {
      position: 'absolute',
      [config.horizontal ? 'left' : 'top']: `${top}px`
    })

    return item
  }

  _getScrollPosition () {
    const config = this._config

    if (typeof config.overrideScrollPosition === 'function') {
      return config.overrideScrollPosition()
    }

    return this._element[config.horizontal ? 'scrollLeft' : 'scrollTop']
  }

  _renderChunk (force) {
    const config = this._config
    const element = this._element
    const scrollTop = this._getScrollPosition()
    const total = config.total

    let from = config.reverse ? this._getReverseFrom(scrollTop) : this._getFrom(scrollTop) - 1

    if (from < 0 || from - this._screenItemsLen < 0) {
      from = 0
    }

    if (!force && this._lastFrom === from) {
      return false
    }

    this._lastFrom = from

    let to = from + this._cachedItemsLen

    if (to > total || to + this._cachedItemsLen > total) {
      to = total
    }

    // Append all the new rows in a document fragment that we will later append
    // to the parent node
    const fragment = document.createDocumentFragment()

    // Keep the scroller in the list of children.
    fragment.appendChild(this._scroller)
    for (let i = from; i < to; i++) {
      fragment.appendChild(this._getRow(i))
    }

    element.innerHTML = ''
    element.appendChild(fragment)
  }

  _computePositions (from = 1) {
    const config = this._config
    const total = config.total
    const reverse = config.reverse

    if (from < 1 && !reverse) {
      from = 1
    }

    for (let i = from; i < total; i++) {
      if (reverse) {
        const a = i === 0 ? this._scrollHeight : this._itemPositions[i - 1]
        this._itemPositions[i] = a - this._itemHeights[i]
      } else {
        this._itemPositions[i] = this._itemHeights[i - 1] + this._itemPositions[i - 1]
      }
    }
  }

  _computeScrollHeight () {
    const config = this._config
    const isHoriz = config.horizontal
    const total = config.total
    const scrollHeight =
      this._itemHeights.reduce((a, b) => a + b, 0) +
      this._scrollPaddingBottom +
      this._scrollPaddingTop

    Object.assign(this._scroller.style, {
      opacity: 0,
      position: 'absolute',
      top: '0px',
      [isHoriz ? 'height' : 'width']: '1px',
      [isHoriz ? 'width' : 'height']: `${scrollHeight}px`
    })

    // Calculate the height median
    const sortedItemHeights = this._itemHeights.slice(0).sort((a, b) => a - b)
    const middle = Math.floor(total / 2)
    const averageHeight = total % 2 === 0
      ? (sortedItemHeights[middle] + sortedItemHeights[middle - 1]) / 2
      : sortedItemHeights[middle]

    const clientProp = isHoriz ? 'clientWidth' : 'clientHeight'
    const element = config.scrollContainer ? config.scrollContainer : this._element
    const containerHeight = element[clientProp] ? element[clientProp] : this._containerSize
    this._screenItemsLen = Math.ceil(containerHeight / averageHeight)
    this._containerSize = containerHeight

    // Cache 3 times the number of items that fit in the container viewport.
    this._cachedItemsLen = Math.max(this._cachedItemsLen || 0, this._screenItemsLen * 3)
    this._averageHeight = averageHeight

    if (config.reverse) {
      window.requestAnimationFrame(() => {
        if (isHoriz) {
          this._element.scrollLeft = scrollHeight
        } else {
          this._element.scrollTop = scrollHeight
        }
      })
    }

    return scrollHeight
  }

  _computeScrollPadding () {
    const config = this._config
    const isHoriz = config.horizontal
    const isReverse = config.reverse
    const styles = window.getComputedStyle(this._element)

    const padding = location => {
      const cssValue = styles.getPropertyValue(`padding-${location}`)
      return parseInt(cssValue, 10) || 0
    }

    let vals
    if (isHoriz && isReverse) {
      vals = ['left', 'right']
    } else if (isHoriz) {
      vals = ['right', 'left']
    } else if (isReverse) {
      vals = ['top', 'bottom']
    } else {
      vals = ['bottom', 'top']
    }

    return {
      bottom: padding(vals[0]),
      top: padding(vals[1])
    }
  }

  _getFrom (scrollTop) {
    let i = 0

    while (this._itemPositions[i] < scrollTop) {
      i++
    }

    return i
  }

  _getReverseFrom (scrollTop) {
    let i = this._config.total - 1

    while (i > 0 && this._itemPositions[i] < scrollTop + this._containerSize) {
      i--
    }

    return i
  }
}
