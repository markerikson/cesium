/*global define*/
define([
        '../Core/Cartesian2',
        '../Core/Cartographic',
        '../Core/Credit',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/DeveloperError',
        '../Core/Event',
        '../Core/GeographicTilingScheme',
        '../Core/joinUrls',
        '../Core/loadXML',
        '../Core/Rectangle',
        '../Core/RequestScheduler',
        '../Core/RuntimeError',
        '../Core/TileProviderError',
        '../Core/WebMercatorTilingScheme',
        '../ThirdParty/when',
        './ImageryProvider'
    ], function(
        Cartesian2,
        Cartographic,
        Credit,
        defaultValue,
        defined,
        defineProperties,
        DeveloperError,
        Event,
        GeographicTilingScheme,
        joinUrls,
        loadXML,
        Rectangle,
        RequestScheduler,
        RuntimeError,
        TileProviderError,
        WebMercatorTilingScheme,
        when,
        ImageryProvider) {
    "use strict";

    /**
     * Provides tiled imagery as generated by {@link http://www.maptiler.org/'>MapTiler</a> / <a href='http://www.klokan.cz/projects/gdal2tiles/|GDDAL2Tiles} etc.
     *
     * @alias TileMapServiceImageryProvider
     * @constructor
     *
     * @param {Object} [options] Object with the following properties:
     * @param {String} [options.url='.'] Path to image tiles on server.
     * @param {String} [options.fileExtension='png'] The file extension for images on the server.
     * @param {Object} [options.proxy] A proxy to use for requests. This object is expected to have a getURL function which returns the proxied URL.
     * @param {Credit|String} [options.credit=''] A credit for the data source, which is displayed on the canvas.
     * @param {Number} [options.minimumLevel=0] The minimum level-of-detail supported by the imagery provider.  Take care when specifying
     *                 this that the number of tiles at the minimum level is small, such as four or less.  A larger number is likely
     *                 to result in rendering problems.
     * @param {Number} [options.maximumLevel] The maximum level-of-detail supported by the imagery provider, or undefined if there is no limit.
     * @param {Rectangle} [options.rectangle=Rectangle.MAX_VALUE] The rectangle, in radians, covered by the image.
     * @param {TilingScheme} [options.tilingScheme] The tiling scheme specifying how the ellipsoidal
     * surface is broken into tiles.  If this parameter is not provided, a {@link WebMercatorTilingScheme}
     * is used.
     * @param {Ellipsoid} [options.ellipsoid] The ellipsoid.  If the tilingScheme is specified,
     *                    this parameter is ignored and the tiling scheme's ellipsoid is used instead. If neither
     *                    parameter is specified, the WGS84 ellipsoid is used.
     * @param {Number} [options.tileWidth=256] Pixel width of image tiles.
     * @param {Number} [options.tileHeight=256] Pixel height of image tiles.
     *
     * @see ArcGisMapServerImageryProvider
     * @see BingMapsImageryProvider
     * @see GoogleEarthImageryProvider
     * @see createOpenStreetMapImageryProvider
     * @see SingleTileImageryProvider
     * @see WebMapServiceImageryProvider
     * @see WebMapTileServiceImageryProvider
     * @see UrlTemplateImageryProvider
     *
     *
     * @example
     * // TileMapService tile provider
     * var tms = new Cesium.TileMapServiceImageryProvider({
     *    url : '../images/cesium_maptiler/Cesium_Logo_Color',
     *    fileExtension: 'png',
     *    maximumLevel: 4,
     *    rectangle: new Cesium.Rectangle(
     *        Cesium.Math.toRadians(-120.0),
     *        Cesium.Math.toRadians(20.0),
     *        Cesium.Math.toRadians(-60.0),
     *        Cesium.Math.toRadians(40.0))
     * });
     * 
     * @see {@link http://www.maptiler.org/|MapTiler}
     * @see {@link http://www.klokan.cz/projects/gdal2tiles/|GDDAL2Tiles}
     * @see {@link http://www.w3.org/TR/cors/|Cross-Origin Resource Sharing}
     */
    function TileMapServiceImageryProvider(options) {
        options = defaultValue(options, {});

        //>>includeStart('debug', pragmas.debug);
        if (!defined(options.url)) {
            throw new DeveloperError('options.url is required.');
        }
        //>>includeEnd('debug');

        var url = options.url;

        this._url = url;
        this._ready = false;
        this._readyPromise = when.defer();
        this._proxy = options.proxy;
        this._tileDiscardPolicy = options.tileDiscardPolicy;
        this._errorEvent = new Event();

        this._fileExtension = options.fileExtension;
        this._tileWidth = options.tileWidth;
        this._tileHeight = options.tileHeight;
        this._minimumLevel = options.minimumLevel;
        this._maximumLevel = options.maximumLevel;
        this._rectangle = Rectangle.clone(options.rectangle);
        this._tilingScheme = options.tilingScheme;

        var credit = options.credit;
        if (typeof credit === 'string') {
            credit = new Credit(credit);
        }
        this._credit = credit;

        var that = this;
        var metadataError;

        function metadataSuccess(xml) {
            var tileFormatRegex = /tileformat/i;
            var tileSetRegex = /tileset/i;
            var tileSetsRegex = /tilesets/i;
            var bboxRegex = /boundingbox/i;
            var srsRegex = /srs/i;
            var format, bbox, tilesets, srs;
            var tilesetsList = []; //list of TileSets

            // Allowing options properties (already copied to that) to override XML values

            // Iterate XML Document nodes for properties
            var nodeList = xml.childNodes[0].childNodes;
            for (var i = 0; i < nodeList.length; i++){
                if (tileFormatRegex.test(nodeList.item(i).nodeName)) {
                    format = nodeList.item(i);
                } else if (tileSetsRegex.test(nodeList.item(i).nodeName)) {
                    tilesets = nodeList.item(i); // Node list of TileSets
                    var tileSetNodes = nodeList.item(i).childNodes;
                    // Iterate the nodes to find all TileSets
                    for(var j = 0; j < tileSetNodes.length; j++) {
                        if (tileSetRegex.test(tileSetNodes.item(j).nodeName)) {
                            // Add them to tilesets list
                            tilesetsList.push(tileSetNodes.item(j));
                        }
                    }
                } else if (bboxRegex.test(nodeList.item(i).nodeName)) {
                    bbox = nodeList.item(i);
                } else if (srsRegex.test(nodeList.item(i).nodeName)) {
                    srs = nodeList.item(i).textContent;
                }
            }

            that._fileExtension = defaultValue(that._fileExtension, format.getAttribute('extension'));
            that._tileWidth = defaultValue(that._tileWidth, parseInt(format.getAttribute('width'), 10));
            that._tileHeight = defaultValue(that._tileHeight, parseInt(format.getAttribute('height'), 10));
            that._minimumLevel = defaultValue(that._minimumLevel, parseInt(tilesetsList[0].getAttribute('order'), 10));
            that._maximumLevel = defaultValue(that._maximumLevel, parseInt(tilesetsList[tilesetsList.length - 1].getAttribute('order'), 10));

            // Determine based on the profile attribute if this tileset was generated by gdal2tiles.py ('mercator' or 'geodetic' profile, in which
            // case X is latitude and Y is longitude) or by a tool compliant with the TMS standard ('global-mercator' or 'global-geodetic' profile,
            // in which case X is longitude and Y is latitude).
            var tilingSchemeName = tilesets.getAttribute('profile');

            var flipXY = false;
            if (tilingSchemeName === 'geodetic' || tilingSchemeName === 'mercator') {
                flipXY = true;
            }

            if (!defined(that._tilingScheme)) {
                if (tilingSchemeName === 'geodetic' || tilingSchemeName === 'global-geodetic') {
                    that._tilingScheme = new GeographicTilingScheme({ ellipsoid : options.ellipsoid });
                } else if (tilingSchemeName === 'mercator' || tilingSchemeName === 'global-mercator') {
                    that._tilingScheme = new WebMercatorTilingScheme({ ellipsoid : options.ellipsoid });
                } else {
                    var message = joinUrls(url, 'tilemapresource.xml') + 'specifies an unsupported profile attribute, ' + tilingSchemeName + '.';
                    metadataError = TileProviderError.handleError(metadataError, that, that._errorEvent, message, undefined, undefined, undefined, requestMetadata);
                    that._readyPromise.reject(new RuntimeError(message));
                    return;
                }
            }

            var tilingScheme = that._tilingScheme;

            // rectangle handling
            if (!defined(that._rectangle)) {
                var swXY;
                var neXY;
                var sw;
                var ne;

                if (flipXY) {
                    swXY = new Cartesian2(parseFloat(bbox.getAttribute('miny')), parseFloat(bbox.getAttribute('minx')));
                    neXY = new Cartesian2(parseFloat(bbox.getAttribute('maxy')), parseFloat(bbox.getAttribute('maxx')));

                    // In old tilers with X/Y flipped, coordinate are always geodetic degrees.
                    sw = Cartographic.fromDegrees(swXY.x, swXY.y);
                    ne = Cartographic.fromDegrees(neXY.x, neXY.y);
                } else {
                    swXY = new Cartesian2(parseFloat(bbox.getAttribute('minx')), parseFloat(bbox.getAttribute('miny')));
                    neXY = new Cartesian2(parseFloat(bbox.getAttribute('maxx')), parseFloat(bbox.getAttribute('maxy')));

                    if (that._tilingScheme instanceof GeographicTilingScheme) {
                        sw = Cartographic.fromDegrees(swXY.x, swXY.y);
                        ne = Cartographic.fromDegrees(neXY.x, neXY.y);
                    } else {
                        var projection = that._tilingScheme.projection;
                        sw = projection.unproject(swXY);
                        ne = projection.unproject(neXY);
                    }
                }

                that._rectangle = new Rectangle(sw.longitude, sw.latitude, ne.longitude, ne.latitude);
            }


            // The rectangle must not be outside the bounds allowed by the tiling scheme.
            if (that._rectangle.west < tilingScheme.rectangle.west) {
                that._rectangle.west = tilingScheme.rectangle.west;
            }
            if (that._rectangle.east > tilingScheme.rectangle.east) {
                that._rectangle.east = tilingScheme.rectangle.east;
            }
            if (that._rectangle.south < tilingScheme.rectangle.south) {
                that._rectangle.south = tilingScheme.rectangle.south;
            }
            if (that._rectangle.north > tilingScheme.rectangle.north) {
                that._rectangle.north = tilingScheme.rectangle.north;
            }

            // Check the number of tiles at the minimum level.  If it's more than four,
            // try requesting the lower levels anyway, because starting at the higher minimum
            // level will cause too many tiles to be downloaded and rendered.
            var swTile = tilingScheme.positionToTileXY(Rectangle.southwest(that._rectangle), that._minimumLevel);
            var neTile = tilingScheme.positionToTileXY(Rectangle.northeast(that._rectangle), that._minimumLevel);
            var tileCount = (Math.abs(neTile.x - swTile.x) + 1) * (Math.abs(neTile.y - swTile.y) + 1);
            if (tileCount > 4) {
                that._minimumLevel = 0;
            }

            that._tilingScheme = tilingScheme;
            that._ready = true;
            that._readyPromise.resolve(true);
        }

        function metadataFailure(error) {
            // Can't load XML, still allow options and defaults
            that._fileExtension = defaultValue(options.fileExtension, 'png');
            that._tileWidth = defaultValue(options.tileWidth, 256);
            that._tileHeight = defaultValue(options.tileHeight, 256);
            that._minimumLevel = defaultValue(options.minimumLevel, 0);
            that._maximumLevel = options.maximumLevel;
            that._tilingScheme = defined(options.tilingScheme) ? options.tilingScheme : new WebMercatorTilingScheme({ ellipsoid : options.ellipsoid });
            that._rectangle = defaultValue(options.rectangle, that._tilingScheme.rectangle);
            that._ready = true;
            that._readyPromise.resolve(true);
        }

        function requestMetadata() {
            var resourceUrl = joinUrls(url, 'tilemapresource.xml');
            var proxy = that._proxy;
            if (defined(proxy)) {
                resourceUrl = proxy.getURL(resourceUrl);
            }
            // Try to load remaining parameters from XML
            when(RequestScheduler.request(resourceUrl, loadXML), metadataSuccess, metadataFailure);
        }

        requestMetadata();
    }

    function buildImageUrl(imageryProvider, x, y, level) {
        var yTiles = imageryProvider._tilingScheme.getNumberOfYTilesAtLevel(level);
        var url = joinUrls(imageryProvider._url, level + '/' + x + '/' + (yTiles - y - 1) + '.' + imageryProvider._fileExtension);

        var proxy = imageryProvider._proxy;
        if (defined(proxy)) {
            url = proxy.getURL(url);
        }

        return url;
    }


    defineProperties(TileMapServiceImageryProvider.prototype, {
        /**
         * Gets the URL of the service hosting the imagery.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {String}
         * @readonly
         */
        url : {
            get : function() {
                return this._url;
            }
        },

        /**
         * Gets the proxy used by this provider.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Proxy}
         * @readonly
         */
        proxy : {
            get : function() {
                return this._proxy;
            }
        },

        /**
         * Gets the width of each tile, in pixels. This function should
         * not be called before {@link TileMapServiceImageryProvider#ready} returns true.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Number}
         * @readonly
         */
        tileWidth : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tileWidth must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tileWidth;
            }
        },

        /**
         * Gets the height of each tile, in pixels.  This function should
         * not be called before {@link TileMapServiceImageryProvider#ready} returns true.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Number}
         * @readonly
         */
        tileHeight: {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tileHeight must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tileHeight;
            }
        },

        /**
         * Gets the maximum level-of-detail that can be requested.  This function should
         * not be called before {@link TileMapServiceImageryProvider#ready} returns true.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Number}
         * @readonly
         */
        maximumLevel : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('maximumLevel must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._maximumLevel;
            }
        },

        /**
         * Gets the minimum level-of-detail that can be requested.  This function should
         * not be called before {@link TileMapServiceImageryProvider#ready} returns true.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Number}
         * @readonly
         */
        minimumLevel : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('minimumLevel must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._minimumLevel;
            }
        },

        /**
         * Gets the tiling scheme used by this provider.  This function should
         * not be called before {@link TileMapServiceImageryProvider#ready} returns true.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {TilingScheme}
         * @readonly
         */
        tilingScheme : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tilingScheme must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tilingScheme;
            }
        },

        /**
         * Gets the rectangle, in radians, of the imagery provided by this instance.  This function should
         * not be called before {@link TileMapServiceImageryProvider#ready} returns true.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Rectangle}
         * @readonly
         */
        rectangle : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('rectangle must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._rectangle;
            }
        },

        /**
         * Gets the tile discard policy.  If not undefined, the discard policy is responsible
         * for filtering out "missing" tiles via its shouldDiscardImage function.  If this function
         * returns undefined, no tiles are filtered.  This function should
         * not be called before {@link TileMapServiceImageryProvider#ready} returns true.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {TileDiscardPolicy}
         * @readonly
         */
        tileDiscardPolicy : {
            get : function() {
                //>>includeStart('debug', pragmas.debug);
                if (!this._ready) {
                    throw new DeveloperError('tileDiscardPolicy must not be called before the imagery provider is ready.');
                }
                //>>includeEnd('debug');

                return this._tileDiscardPolicy;
            }
        },

        /**
         * Gets an event that is raised when the imagery provider encounters an asynchronous error.  By subscribing
         * to the event, you will be notified of the error and can potentially recover from it.  Event listeners
         * are passed an instance of {@link TileProviderError}.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Event}
         * @readonly
         */
        errorEvent : {
            get : function() {
                return this._errorEvent;
            }
        },

        /**
         * Gets a value indicating whether or not the provider is ready for use.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Boolean}
         * @readonly
         */
        ready : {
            get : function() {
                return this._ready;
            }
        },

        /**
         * Gets a promise that resolves to true when the provider is ready for use.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Promise.<Boolean>}
         * @readonly
         */
        readyPromise : {
            get : function() {
                return this._readyPromise.promise;
            }
        },

        /**
         * Gets the credit to display when this imagery provider is active.  Typically this is used to credit
         * the source of the imagery.  This function should not be called before {@link TileMapServiceImageryProvider#ready} returns true.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Credit}
         * @readonly
         */
        credit : {
            get : function() {
                return this._credit;
            }
        },

        /**
         * Gets a value indicating whether or not the images provided by this imagery provider
         * include an alpha channel.  If this property is false, an alpha channel, if present, will
         * be ignored.  If this property is true, any images without an alpha channel will be treated
         * as if their alpha is 1.0 everywhere.  When this property is false, memory usage
         * and texture upload time are reduced.
         * @memberof TileMapServiceImageryProvider.prototype
         * @type {Boolean}
         * @readonly
         */
        hasAlphaChannel : {
            get : function() {
                return true;
            }
        }
    });

    /**
     * Gets the credits to be displayed when a given tile is displayed.
     *
     * @param {Number} x The tile X coordinate.
     * @param {Number} y The tile Y coordinate.
     * @param {Number} level The tile level;
     * @returns {Credit[]} The credits to be displayed when the tile is displayed.
     *
     * @exception {DeveloperError} <code>getTileCredits</code> must not be called before the imagery provider is ready.
     */
    TileMapServiceImageryProvider.prototype.getTileCredits = function(x, y, level) {
        return undefined;
    };

    /**
     * Requests the image for a given tile.  This function should
     * not be called before {@link TileMapServiceImageryProvider#ready} returns true.
     *
     * @param {Number} x The tile X coordinate.
     * @param {Number} y The tile Y coordinate.
     * @param {Number} level The tile level.
     * @param {Number} [distance] The distance of the tile from the camera, used to prioritize requests.
     * @returns {Promise.<Image|Canvas>|undefined} A promise for the image that will resolve when the image is available, or
     *          undefined if there are too many active requests to the server, and the request
     *          should be retried later.  The resolved image may be either an
     *          Image or a Canvas DOM object.
     */
    TileMapServiceImageryProvider.prototype.requestImage = function(x, y, level, distance) {
        //>>includeStart('debug', pragmas.debug);
        if (!this._ready) {
            throw new DeveloperError('requestImage must not be called before the imagery provider is ready.');
        }
        //>>includeEnd('debug');

        var url = buildImageUrl(this, x, y, level);
        return ImageryProvider.loadImage(this, url, distance);
    };

    /**
     * Picking features is not currently supported by this imagery provider, so this function simply returns
     * undefined.
     *
     * @param {Number} x The tile X coordinate.
     * @param {Number} y The tile Y coordinate.
     * @param {Number} level The tile level.
     * @param {Number} longitude The longitude at which to pick features.
     * @param {Number} latitude  The latitude at which to pick features.
     * @return {Promise.<ImageryLayerFeatureInfo[]>|undefined} A promise for the picked features that will resolve when the asynchronous
     *                   picking completes.  The resolved value is an array of {@link ImageryLayerFeatureInfo}
     *                   instances.  The array may be empty if no features are found at the given location.
     *                   It may also be undefined if picking is not supported.
     */
    TileMapServiceImageryProvider.prototype.pickFeatures = function() {
        return undefined;
    };

    return TileMapServiceImageryProvider;
});
