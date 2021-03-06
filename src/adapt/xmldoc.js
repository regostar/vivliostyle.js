/**
 * Copyright 2013 Google, Inc.
 * Copyright 2015 Trim-marks Inc.
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @fileoverview Utility functions to work with XML (mostly XHTML) documents.
 */

goog.provide('adapt.xmldoc');

goog.require('adapt.base');
goog.require('adapt.task');
goog.require('adapt.taskutil');
goog.require('adapt.net');

/**
 * @const
 */
adapt.xmldoc.ELEMENT_OFFSET_ATTR = "data-adapt-eloff";

/**
 * @param {adapt.xmldoc.XMLDocStore} store
 * @param {string} url
 * @param {Document} document
 * @constructor
 */
adapt.xmldoc.XMLDocHolder = function(store, url, document) {
    /** @const */ this.store = store;
    /** @const */ this.url = url;
    /** @const */ this.document = document;
    /** @type {?string} */ this.lang = null;
    /** @type {number} */ this.totalOffset = -1;
    /**
     * @type {!Element}
     * @const
     */
    this.root = document.documentElement;  // html element
    let body = null;
    let head = null;
    if (this.root.namespaceURI == adapt.base.NS.XHTML) {
        for (var child = this.root.firstChild; child; child = child.nextSibling) {
            if (child.nodeType != 1)
                continue;
            var elem = /** @type {Element} */ (child);
            if (elem.namespaceURI == adapt.base.NS.XHTML) {
                switch (elem.localName) {
                    case 'head' :
                        head = elem;
                        break;
                    case 'body' :
                        body = elem;
                        break;
                }
            }
        }
        this.lang = this.root.getAttribute("lang");
    } else if (this.root.namespaceURI == adapt.base.NS.FB2) {
        head = this.root;
        for (var child = this.root.firstChild; child; child = child.nextSibling) {
            if (child.nodeType != 1)
                continue;
            var elem = /** @type {Element} */ (child);
            if (elem.namespaceURI == adapt.base.NS.FB2) {
                if (elem.localName == "body") {
                    body = elem;
                }
            }
        }
        const langs = this.doc().child("FictionBook").child("description")
            .child("title-info").child("lang").textContent();
        if (langs.length > 0) {
            this.lang = langs[0];
        }
    } else if (this.root.namespaceURI == adapt.base.NS.SSE) {
        // treat <meta> element as "head" of the document
        for (var elem = this.root.firstElementChild; elem; elem = elem.nextElementSibling) {
            const localName = elem.localName;
            if (localName === "meta") {
                head = elem;
            } else if (localName === "body") {
                body = elem;
            }
        }
    }
    /**
     * @type {Element}
     * @const
     */
    this.body = body;
    /**
     * @type {Element}
     * @const
     */
    this.head = head;
    /** @type {Element} */ this.last = this.root;
    /** @type {number} */ this.lastOffset = 1;
    this.last.setAttribute(adapt.xmldoc.ELEMENT_OFFSET_ATTR, "0");
};

/**
 * @return {adapt.xmldoc.NodeList}
 */
adapt.xmldoc.XMLDocHolder.prototype.doc = function() {
    return new adapt.xmldoc.NodeList([this.document]);
};

/**
 * @param {Element} element
 * @return {number}
 */
adapt.xmldoc.XMLDocHolder.prototype.getElementOffset = function(element) {
    const offsetStr = element.getAttribute(adapt.xmldoc.ELEMENT_OFFSET_ATTR);
    if (offsetStr)
        return parseInt(offsetStr, 10);
    let offset = this.lastOffset;
    let last = this.last;
    while (last != element) {
        let next = last.firstChild;
        if (!next) {
            while (true) {
                next = last.nextSibling;
                if (next)
                    break;
                last = last.parentNode;
                if (last == null)
                    throw new Error("Internal error");
            }
        }
        last = next;
        if (next.nodeType == 1) {
            const nextElement = /** @type {Element} */ (next);
            nextElement.setAttribute(adapt.xmldoc.ELEMENT_OFFSET_ATTR, offset.toString());
            ++offset;
        } else {
            offset += next.textContent.length;
        }
    }
    this.lastOffset = offset;
    this.last = element;
    return offset - 1;
};

/**
 * @param {Node} srcNode
 * @param {number} offsetInNode
 * @param {boolean} after
 */
adapt.xmldoc.XMLDocHolder.prototype.getNodeOffset = function(srcNode, offsetInNode, after) {
    let extraOffset = 0;
    let node = srcNode;
    let prev = null;
    if (node.nodeType == 1) {
        // after = true is only valid for elements
        if (!after)
            return this.getElementOffset(/** @type {Element} */ (node));
    } else {
        // offsetInNode is only valid for text nodes
        extraOffset = offsetInNode;
        prev = node.previousSibling;
        if (!prev) {
            node = node.parentNode;
            extraOffset += 1;
            return this.getElementOffset(/** @type {Element} */ (node)) + extraOffset;
        }
        node = prev;
    }
    while (true) {
        while (node.lastChild) {
            node = node.lastChild;
        }
        if (node.nodeType == 1) {
            // empty element
            break;
        }
        extraOffset += node.textContent.length;
        prev = node.previousSibling;
        if (!prev) {
            node = node.parentNode;
            break;
        }
        node = prev;
    }
    extraOffset += 1;
    return this.getElementOffset(/** @type {Element} */ (node)) + extraOffset;
};

/**
 * @return {number}
 */
adapt.xmldoc.XMLDocHolder.prototype.getTotalOffset = function() {
    if (this.totalOffset < 0) {
        this.totalOffset = this.getNodeOffset(this.root, 0, true);
    }
    return this.totalOffset;
};

/**
 * @param {number} offset
 * @return {Node} last node such that its offset is less or equal to the given
 */
adapt.xmldoc.XMLDocHolder.prototype.getNodeByOffset = function(offset) {
    let elementOffset;
    // First, find the last element in the document, such that
    // this.getElementOffset(element) <= offset; if offest matches
    // exactly, just return it.
    const self = this;
    let element = this.root;
    while (true) {
        elementOffset = this.getElementOffset(element);
        if (elementOffset >= offset)
            return element;
        const children = element.children; // Element children
        if (!children)
            break;
        const index = adapt.base.binarySearch(children.length, index => {
            const child = children[index];
            const childOffset = self.getElementOffset(child);
            return childOffset > offset;
        });
        if (index == 0) {
            break;
        }
        if (goog.DEBUG) {
            if (index < children.length) {
                const elemOffset = self.getElementOffset(children[index]);
                if (elemOffset <= offset)
                    throw new Error("Consistency check failed!");
            }
        }
        element = children[index-1];
    }
    // Now we have element with offset less than desired. Find following (non-element)
    // node with the right offset.
    let nodeOffset = elementOffset + 1;
    let node = element;
    let next = node.firstChild || node.nextSibling;
    let lastGood = null;
    while (true) {
        if (next) {
            if (next.nodeType == 1)
                break;
            node = next;
            lastGood = node;
            nodeOffset += next.textContent.length;
            if (nodeOffset > offset)
                break;
        } else {
            node = node.parentNode;
            if (!node)
                break;
        }
        next = node.nextSibling;
    }
    return lastGood || element;
};

/**
 * @private
 * @param {Element} e
 * @return {void}
 */
adapt.xmldoc.XMLDocHolder.prototype.buildIdMap = function(e) {
    const id = e.getAttribute("id");
    if (id && !this.idMap[id]) {
        this.idMap[id] = e;
    }
    const xmlid = e.getAttributeNS(adapt.base.NS.XML, "id");
    if (xmlid && !this.idMap[xmlid]) {
        this.idMap[xmlid] = e;
    }
    for (let c = e.firstElementChild; c; c = c.nextElementSibling) {
        this.buildIdMap(c);
    }
};

/**
 * Get element by URL in the source document(s). URL must be in either '#id' or
 * 'url#id' form.
 * @param {string} url
 * @return {Element}
 */
adapt.xmldoc.XMLDocHolder.prototype.getElement = function(url) {
    const m = url.match(/([^#]*)\#(.+)$/);
    if (!m || (m[1] && m[1] != this.url)) {
        return null;
    }
    const id = m[2];
    let r = this.document.getElementById(id);
    if (!r && this.document.getElementsByName) {
        r = this.document.getElementsByName(id)[0];
    }
    if (!r) {
        if (!this.idMap) {
            this.idMap = {};
            this.buildIdMap(this.document.documentElement);
        }
        r = this.idMap[id];
    }
    return r;
};

/**
 * @typedef {adapt.net.ResourceStore.<adapt.xmldoc.XMLDocHolder>}
 */
adapt.xmldoc.XMLDocStore;

/**
 * cf. https://w3c.github.io/DOM-Parsing/#the-domparser-interface
 * @enum {string}
 * @private
 */
adapt.xmldoc.DOMParserSupportedType = {
    TEXT_HTML: "text/html",
    TEXT_XML: "text/xml",
    APPLICATION_XML: "application/xml",
    APPLICATION_XHTML_XML: "application/xhtml_xml",
    IMAGE_SVG_XML: "image/svg+xml"
};

/**
 * Parses a string with a DOMParser and returns the document.
 * If a parse error occurs, return null.
 * @param {string} str
 * @param {string} type
 * @param {DOMParser=} opt_parser
 * @returns {Document}
 */
adapt.xmldoc.parseAndReturnNullIfError = (str, type, opt_parser) => {
    const parser = opt_parser || new DOMParser();
    let doc;
    try {
        doc = parser.parseFromString(str, type);
    } catch (e) {}

    if (!doc) {
        return null;
    } else {
        const docElement = doc.documentElement;
        const errorTagName = "parsererror";
        if (docElement.localName === errorTagName) {
            return null;
        } else {
            for (let c = docElement.firstChild; c; c = c.nextSibling) {
                if (c.localName === errorTagName) {
                    return null;
                }
            }
        }
    }
    return doc;
};

/**
 * @private
 * @param {adapt.net.Response} response
 * @returns {?string} null if contentType cannot be inferred from HTTP header and file extension
 */
adapt.xmldoc.resolveContentType = response => {
    const contentType = response.contentType;
    if (contentType) {
        const supportedKeys = Object.keys(adapt.xmldoc.DOMParserSupportedType);
        for (let i = 0; i < supportedKeys.length; i++) {
            if (adapt.xmldoc.DOMParserSupportedType[supportedKeys[i]] === contentType) {
                return contentType;
            }
        }
        if (contentType.match(/\+xml$/)) {
            return adapt.xmldoc.DOMParserSupportedType.APPLICATION_XML;
        }
    }
    const match = response.url.match(/\.([^./]+)$/);
    if (match) {
        const extension = match[1];
        switch (extension) {
            case "html":
            case "htm":
                return adapt.xmldoc.DOMParserSupportedType.TEXT_HTML;
            case "xhtml":
            case "xht":
                return adapt.xmldoc.DOMParserSupportedType.APPLICATION_XHTML_XML;
            case "svg":
            case "svgz":
                return adapt.xmldoc.DOMParserSupportedType.IMAGE_SVG_XML;
            case "opf":
            case "xml":
                return adapt.xmldoc.DOMParserSupportedType.APPLICATION_XML;
        }
    }
    return null;
};

/**
 * @param {adapt.net.Response} response
 * @param {adapt.xmldoc.XMLDocStore} store
 * @return {!adapt.task.Result.<adapt.xmldoc.XMLDocHolder>}
 */
adapt.xmldoc.parseXMLResource = (response, store) => {
    let doc = response.responseXML;
    if (!doc) {
        const parser = new DOMParser();
        const text = response.responseText;
        if (text) {
            const contentType = adapt.xmldoc.resolveContentType(response);
            doc = adapt.xmldoc.parseAndReturnNullIfError(text, contentType || adapt.xmldoc.DOMParserSupportedType.APPLICATION_XML, parser);

            // When contentType cannot be inferred from HTTP header and file extension,
            // we use root element's tag name to infer the contentType.
            // If it is html or svg, we re-parse the source with an appropriate contentType.
            if (doc && !contentType) {
                const root = doc.documentElement;
                if (root.localName.toLowerCase() === "html" && !root.namespaceURI) {
                    doc = adapt.xmldoc.parseAndReturnNullIfError(text, adapt.xmldoc.DOMParserSupportedType.TEXT_HTML, parser);
                } else if (root.localName.toLowerCase() === "svg" && doc.contentType !== adapt.xmldoc.DOMParserSupportedType.IMAGE_SVG_XML) {
                    doc = adapt.xmldoc.parseAndReturnNullIfError(text, adapt.xmldoc.DOMParserSupportedType.IMAGE_SVG_XML, parser);
                }
            }

            if (!doc) {
                // Fallback to HTML parsing
                doc = adapt.xmldoc.parseAndReturnNullIfError(text, adapt.xmldoc.DOMParserSupportedType.TEXT_HTML, parser);
            }
        }
    }
    const xmldoc = doc ? new adapt.xmldoc.XMLDocHolder(store, response.url, doc) : null;
    return adapt.task.newResult(xmldoc);
};

/**
 * @return {adapt.xmldoc.XMLDocStore}
 */
adapt.xmldoc.newXMLDocStore = () => new adapt.net.ResourceStore(adapt.xmldoc.parseXMLResource, adapt.net.XMLHttpRequestResponseType.DOCUMENT);

/**
 * @constructor
 * @param {function(Node):boolean} fn
 */
adapt.xmldoc.Predicate = function(fn) {
    /** @const */ this.fn = fn;
};

/**
 * @param {Node} node
 * @return {boolean}
 */
adapt.xmldoc.Predicate.prototype.check = function(node) {
    return this.fn(node);
};

/**
 * @param {string} name
 * @param {string} value
 * @return {adapt.xmldoc.Predicate}
 */
adapt.xmldoc.Predicate.prototype.withAttribute = function(name, value) {
    const self = this;
    return new adapt.xmldoc.Predicate(node => self.check(node) && node.nodeType == 1 &&
        (/** @type {Element} */ (node)).getAttribute(name) == value);
};

/**
 * @param {string} name
 * @param {adapt.xmldoc.Predicate=} opt_childPredicate
 * @return {adapt.xmldoc.Predicate}
 */
adapt.xmldoc.Predicate.prototype.withChild = function(name, opt_childPredicate) {
    const self = this;
    return new adapt.xmldoc.Predicate(node => {
        if (!self.check(node)) {
            return false;
        }
        let list = new adapt.xmldoc.NodeList([node]);
        list = list.child(name);
        if (opt_childPredicate) {
            list = list.predicate(opt_childPredicate);
        }
        return list.size() > 0;
    });
};

/**
 * @const
 */
adapt.xmldoc.predicate = new adapt.xmldoc.Predicate(node => true);


/**
 * @param {Array.<!Node>} nodes
 * @constructor
 */
adapt.xmldoc.NodeList = function(nodes) {
    /** @const */ this.nodes = nodes;
};

/**
 * @return {Array.<!Node>}
 */
adapt.xmldoc.NodeList.prototype.asArray = function() {
    return this.nodes;
};

/**
 * @return {number}
 */
adapt.xmldoc.NodeList.prototype.size = function() {
    return this.nodes.length;
};

/**
 * Filter with predicate
 * @param {adapt.xmldoc.Predicate} pr
 * @return {adapt.xmldoc.NodeList}
 */
adapt.xmldoc.NodeList.prototype.predicate = function(pr) {
    const arr = [];

    for (const n of this.nodes) {
        if (pr.check(n)) {
            arr.push(n);
        }
    }

    return new adapt.xmldoc.NodeList(arr);
};

/**
 * @param {function(!Node,function(!Node):void):void} fn
 * @return {adapt.xmldoc.NodeList}
 */
adapt.xmldoc.NodeList.prototype.forEachNode = function(fn) {
    const arr = [];
    const add = n => {arr.push(n);};
    for (let i = 0; i < this.nodes.length; i++) {
        fn(this.nodes[i], add);
    }
    return new adapt.xmldoc.NodeList(arr);
};

/**
 * @template T
 * @param {function(!Node):T} fn
 * @return {Array.<T>}
 */
adapt.xmldoc.NodeList.prototype.forEach = function(fn) {
    const arr = [];
    for (let i = 0; i < this.nodes.length; i++) {
        arr.push(fn(this.nodes[i]));
    }
    return arr;
};

/**
 * @template T
 * @param {function(!Node):T} fn
 * @return {Array.<T>}
 */
adapt.xmldoc.NodeList.prototype.forEachNonNull = function(fn) {
    const arr = [];
    for (let i = 0; i < this.nodes.length; i++) {
        const t = fn(this.nodes[i]);
        if (t != null) {
            arr.push(t);
        }
    }
    return arr;
};

/**
 * @param {string} tag
 * @return {adapt.xmldoc.NodeList}
 */
adapt.xmldoc.NodeList.prototype.child = function(tag) {
    return this.forEachNode((node, add) => {
        for (let c = node.firstChild; c; c = c.nextSibling) {
            if (c.localName == tag) {
                add(c);
            }
        }
    });
};

/**
 * @return {adapt.xmldoc.NodeList}
 */
adapt.xmldoc.NodeList.prototype.childElements = function() {
    return this.forEachNode((node, add) => {
        for (let c = node.firstChild; c; c = c.nextSibling) {
            if (c.nodeType == 1) {
                add(c);
            }
        }
    });
};

/**
 * @param {string} name
 * @return {Array.<?string>}
 */
adapt.xmldoc.NodeList.prototype.attribute = function(name) {
    return this.forEachNonNull(node => {
        if (node.nodeType == 1) {
            return (/** @type {Element} */ (node)).getAttribute(name);
        }
        return null;
    });
};

/**
 * @return {Array.<?string>}
 */
adapt.xmldoc.NodeList.prototype.textContent = function() {
    return this.forEach(node => node.textContent);
};
