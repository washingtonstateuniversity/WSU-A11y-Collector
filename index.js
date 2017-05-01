"use strict";

var es = require( "elasticsearch" );
var pa11y = require( "pa11y" );
const util = require( "util" );

require( "dotenv" ).config();

var elastic = new es.Client( {
	host: process.env.ES_HOST,
	log: "error"
} );

var scanner = pa11y( {
	standard: "WCAG2AA",
	timeout: 10000,
	wait: 10,
	page: {
		viewport: {
			width: 1366,
			height: 768
		},
		settings: {
			resourceTimeout: 10000,
			userAgent: "WSU Accessibility Crawler: web.wsu.edu/crawler/"
		}
	}
} );

var url_cache = [];

// These subdomains are flagged to not be scanned.
var flagged_domains = process.env.SKIP_DOMAINS.split( "," );

// Deletes the existing accessibility records for a URL from the ES index.
var deleteAccessibilityRecord = function( url_data ) {
	return new Promise( function( resolve, reject ) {
		elastic.deleteByQuery( {
			index: process.env.ES_INDEX,
			body: {
				query: {
					term: {
						url: encodeURIComponent( url_data.url )
					}
				}
			}
		}, function( error, response ) {
			if ( undefined !== typeof response ) {
				util.log( "Deleted " + response.total + " previous records in " + response.took + " ms." );
				resolve( url_data );
			} else {
				reject( "Error deleting accessibility records for " + url_data.url );
			}
		} );
	} );
};

// Scans a URL for accessibility issues using Pa11y and logs
// these results to an ES index.
var scanAccessibility = function( url_data ) {
	return new Promise( function( resolve ) {
		if ( -1 < flagged_domains.indexOf( url_data.domain ) ) {
			util.log( "Error: Skipping flagged domain " + url_data.domain );
			resolve( url_data );
			return;
		}

		scanner.run( url_data.url, function( error, result ) {
			if ( error ) {
				util.log( error.message );
				resolve( url_data );
				return;
			}

			if ( "undefined" === typeof result ) {
				util.log( "Scanning failed or had 0 results for " + url_data.url );
				resolve( url_data );
				return;
			}

			var bulk_body = [];

			// Append domain and URL information to each result and build a
			// set of bulk data to send to ES.
			for ( var i = 0, x = result.length; i < x; i++ ) {

				result[ i ].domain = url_data.domain;
				result[ i ].url = url_data.url;

				// Create a single document of the "record type" for every record
				// returned against a URL.
				bulk_body.push( { index: { _index: process.env.ES_INDEX, _type: "record" } } );
				bulk_body.push( result[ i ] );
			}

			elastic.bulk( {
				body: bulk_body
			}, function( err, response ) {
				if ( undefined !== typeof response ) {
					util.log( "Scan complete: Logged " + response.items.length + " records in " + response.took + "ms." );
					resolve( url_data );
				} else {
					util.log( err );
					resolve( url_data );
				}
			} );
		} );
	} );
};

// Retrieves the next set of URLs that should be scanned from the ES index.
var getURL = function() {
	return new Promise( function( resolve, reject ) {

		// Check for a URL in the existing cache from our last lookup.
		if ( 0 !== url_cache.length ) {
			var url_data = {
				id: url_cache[ 0 ]._id,
				url: url_cache[ 0 ]._source.url,
				domain: url_cache[ 0 ]._source.domain
			};
			url_cache.shift();

			resolve( url_data );
			return;
		}

		elastic.msearch( {
			index: process.env.ES_URL_INDEX,
			type: "url",
			body: [
				// Query for URLs that have never been scanned.
				{},
				{
					query: {
						bool: {
							must_not: [
								{
									exists: {
										field: "last_a11y_scan"
									}
								}
							],
							must: [
								{
									match: {
										status_code: 200
									}
								}
							]
						}
					},
					size: 5
				},
				// Query for least recently scanned URLs.
				{},
				{
					sort : [
						{
							last_a11y_scan : {
								"order" : "asc"
							}
						}
					],
					query: {
						bool: {
							must: [
								{
									exists: {
										field: "last_a11y_scan"
									}
								},
								{
									match: {
										status_code: 200
									}
								}
							]
						}
					},
					size: 5
				}
			]
		} ).then( function( response ) {
			if ( 2 !== response.responses.length ) {
				reject( "Invalid response set from multisearch." );
			} else {
				if ( 0 !== response.responses[0].hits.hits.length ) {
					url_cache = url_cache.concat( response.responses[0].hits.hits );
				}

				if ( 0 !== response.responses[1].hits.hits.length ) {
					url_cache = url_cache.concat( response.responses[1].hits.hits );
				}

				util.log( "Query for URLs to scan found " + url_cache.length + "." );

				if ( 0 === url_cache.length ) {
					reject( "No new URLs to scan." );
				} else {
					var url_data = {
						id: url_cache[ 0 ]._id,
						url: url_cache[ 0 ]._source.url,
						domain: url_cache[ 0 ]._source.domain
					};
					url_cache.shift();

					resolve( url_data );
				}
			}
		}, function( error ) {
			reject( "Error: " + error.message );
		} );
	} );
};

// Logs the completion of a scan by updating the last updated
// date in the URL index.
var logScanDate = function( url_data ) {
	var d = new Date();

	elastic.update( {
		index: process.env.ES_URL_INDEX,
		type: "url",
		id: url_data.id,
		body: {
			doc: {
				last_a11y_scan: d.getTime()
			}
		}
	} ).then( function() {
		queueScan();
	}, function( error ) {
		util.log( "Error: " + error.message );
		queueScan();
	} );
};

// Manages the scan of an individual URL. Triggers the deletion of
// previous associated records and then triggers the collection of
// new accessibility data.
var scanURL = function( url_data ) {
	util.log( "Scan " + url_data.url );

	return new Promise( function( resolve, reject ) {
		deleteAccessibilityRecord( url_data )
			.then( scanAccessibility )
			.catch( function( error ) {
				util.log( error );
			} )
			.then( function( url_data ) {
				resolve( url_data );
			} )
			.catch( function( error ) {
				reject( error );
			} );
	} );
};

// Manages the process of the scan from start to finish.
var processScan = function() {
	getURL()
		.then( scanURL )
		.then( logScanDate )
		.catch( function( error ) {
			util.log( error );
			queueScan();
		} );
};

// Queues a new accessibility scan for collection.
var queueScan = function() {
	setTimeout( processScan, 100 );
};

// Start things up immediately on run.
queueScan();
