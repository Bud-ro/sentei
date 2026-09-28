import 'package:acme_backend/src/greeting.dart';
import 'package:dart_frog/dart_frog.dart';

// Expected: no finding. dart_frog calls `onRequest` of every routes/ file
// (VeryGoodOpenSource flutter_and_friends backend: PRIV-DEAD).
Response onRequest(RequestContext context) => Response(body: greeting());

// Expected: private_dead, reasons ["already_unreachable"].
String unusedRouteHelper() => 'unused';
