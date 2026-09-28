import 'package:dart_frog/dart_frog.dart';

// Expected: no finding (a nested route).
Response onRequest(RequestContext context) => Response(body: '[]');
