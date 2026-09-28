import 'package:pigeon/pigeon.dart';

// A pigeon input: the code generator reads it, nothing imports it
// (fluttercommunity workmanager: 19 PRIV-DEAD rows, Baseflow geocoding_android).
// Expected: no finding for any declaration of this file.
@ConfigurePigeon(PigeonOptions(dartOut: 'lib/src/messages.g.dart'))
class GreetRequest {
  String? name;
}

@HostApi()
abstract class GreeterHostApi {
  String greet(GreetRequest request);
}
